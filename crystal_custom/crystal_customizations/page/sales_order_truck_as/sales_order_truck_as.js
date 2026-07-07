frappe.pages['sales-order-truck-as'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Truck Assignment',
		single_column: true,
	});
	new TruckAssignmentManager(page);
};

class TruckAssignmentManager {
	constructor(page) {
		this.page = page;
		this.orders = [];
		this.available_trucks = [];
		this.current_page = 1;
		this.page_size = 50;
		this.search_term = '';
		this.selected_orders = new Set();
		this.saved_meta = {};
		this.closed_trucks = [];
		this.trucks_tab = 'active';
		this._sps = new Set();
		this._regions = new Set();
		this.setup_page();
		this.load_trucks_from_orders();
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	setup_page() {
		const today = frappe.datetime.get_today();

		this.page.add_field({
			label: 'From Date', fieldtype: 'Date', fieldname: 'from_date',
			default: frappe.datetime.add_days(today, -30),
			change: () => this.load_data(),
		});
		this.page.add_field({
			label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
			default: today,
			change: () => this.load_data(),
		});
		this.page.add_field({
			label: 'Region', fieldtype: 'Link', fieldname: 'delivery_region',
			options: 'Delivery Region',
			placeholder: 'Add…',
			change: () => {
				const v = this.page.fields_dict.delivery_region.get_value();
				if (!v) return;
				this._regions.add(v);
				setTimeout(() => this.page.fields_dict.delivery_region.set_value(''), 50);
				this._render_region_pills();
				this.current_page = 1; this.load_data();
			},
		});
		this._region_pills_wrap = $('<div class="region-pills-wrap"></div>').appendTo(this.page.page_form);
		this.page.add_field({
			label: 'Sales Person', fieldtype: 'Link', fieldname: 'sales_person',
			options: 'Sales Person',
			placeholder: 'Add…',
			change: () => {
				const v = this.page.fields_dict.sales_person.get_value();
				if (!v) return;
				this._sps.add(v);
				setTimeout(() => this.page.fields_dict.sales_person.set_value(''), 50);
				this._render_sp_pills();
				this.load_data();
			}
		});
		this._sp_pills_wrap = $('<div class="sp-pills-wrap"></div>').appendTo(this.page.page_form);
		this.page.add_field({
			label: 'Search', fieldtype: 'Data', fieldname: 'search_query',
			placeholder: 'Customer or order no…',
			change: () => {
				this.search_term = this.page.fields_dict.search_query.get_value() || '';
				this.current_page = 1;
				this.render_view();
			},
		});

		this.page.set_primary_action('Add Truck', () => this.add_new_truck(), 'octicon octicon-plus');
		this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');

		this.container = $('<div class="ta-container"></div>').appendTo(this.page.main);
	}

	_gen_trip_id() {
		return 'TRP-' + Date.now().toString(36).slice(-4).toUpperCase() + Math.random().toString(36).substr(2, 2).toUpperCase();
	}

	add_new_truck() {
		frappe.prompt([
			{ label: 'Truck Number', fieldname: 'truck_number', fieldtype: 'Data', reqd: 1 },
			{ label: 'Driver Name', fieldname: 'driver_name', fieldtype: 'Data' },
			{ label: 'Capacity (kg)', fieldname: 'capacity_kg', fieldtype: 'Float', default: 5000 },
		], (vals) => {
			vals.trip_id = this._gen_trip_id();
			this.available_trucks.push(vals);
			this._save_truck_meta();
			frappe.show_alert({ message: __('Truck {0} added ({1})', [vals.truck_number, vals.trip_id]), indicator: 'green' });
			this.render_view();
		}, __('Add Truck'), __('Add'));
	}

	// ── Data loading ──────────────────────────────────────────────────────────

	load_trucks_from_orders() {
		// Load saved truck metadata first, then discover truck numbers from orders
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_meta',
			callback: (meta_r) => {
				try {
					(JSON.parse(meta_r.message || '[]') || []).forEach(t => {
						this.saved_meta[t.truck_number] = t;
					});
				} catch(e) {}

				frappe.call({
					method: 'frappe.client.get_list',
					args: {
						doctype: 'Sales Order',
						fields: ['custom_truck_number'],
						filters: [
							['Sales Order', 'docstatus', 'in', [0, 1]],
							['Sales Order', 'custom_truck_number', '!=', ''],
							['Sales Order', 'status', 'not in', ['Completed', 'Closed']],
							['Sales Order', 'custom_truck_closed', '!=', 1],
						],
						limit_page_length: 500,
					},
					callback: (r) => {
						if (r.message) {
							[...new Set(r.message.map(o => o.custom_truck_number).filter(Boolean))].forEach(t => {
								if (!this.available_trucks.find(x => x.truck_number === t)) {
									const m = this.saved_meta[t] || {};
									this.available_trucks.push({
										truck_number: t,
										driver_name:  m.driver_name  || '',
										capacity_kg:  m.capacity_kg  != null ? m.capacity_kg : 5000,
										trip_id:      m.trip_id      || this._gen_trip_id(),
									});
								}
							});
							// Persist any newly-generated trip IDs so they survive page reloads
							if (this.available_trucks.some(t => !(this.saved_meta[t.truck_number] || {}).trip_id)) {
								this._save_truck_meta();
							}
						}
						// Fetch closed-truck history before first render
						frappe.call({
							method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_closed_trucks',
							callback: (cr) => {
								try { this.closed_trucks = JSON.parse(cr.message || '[]') || []; } catch(e) {}
								// saved_meta (available_trucks) is authoritative for active trucks;
								// closed_trucks is display-only history — do not filter active list by it,
								// since trucks in rotation will appear in history AND be re-added as active.
								this.load_data();
							},
							error: () => this.load_data(),
						});
					},
				});
			},
		});
	}

	load_data() {
		this.selected_orders.clear();
		this.container.html(this._loading_html());
		const from = this.page.fields_dict.from_date.get_value();
		const to   = this.page.fields_dict.to_date.get_value();

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_assignment_orders',
			args: {
				from_date:           from || null,
				to_date:             to   || null,
				sales_persons_json:  this._sps.size ? JSON.stringify([...this._sps]) : null,
				regions_json:        this._regions.size ? JSON.stringify([...this._regions]) : null,
			},
			callback: (r) => {
				const result = r.message || { assigned: [], unassigned: [] };
				const truck_rows     = result.assigned   || [];
				const unassigned_rows = result.unassigned || [];

				// Merge: truck-assigned always win; add unassigned not already present
				const seen   = new Set(truck_rows.map(o => o.name));
				const merged = [...truck_rows, ...unassigned_rows.filter(o => !seen.has(o.name))];

				// Exclude Order Confirmed orders with no truck (planning is done)
				this.orders = merged.filter(o =>
					o.workflow_state !== 'Order Confirmed' || !!o.custom_truck_number
				);

				// Seed any newly-seen truck numbers, restoring saved metadata
				let seeded_new_trip_id = false;
				this.orders.forEach(o => {
					if (o.custom_truck_number && !this.available_trucks.find(t => t.truck_number === o.custom_truck_number)) {
						const m = this.saved_meta[o.custom_truck_number] || {};
						const trip_id = m.trip_id || this._gen_trip_id();
						if (!m.trip_id) seeded_new_trip_id = true;
						this.available_trucks.push({
							truck_number: o.custom_truck_number,
							driver_name:  m.driver_name  || '',
							capacity_kg:  m.capacity_kg  != null ? m.capacity_kg : 5000,
							trip_id,
						});
					}
				});
				if (seeded_new_trip_id) this._save_truck_meta();

				// Fetch customer locations then render
				const customers = [...new Set(this.orders.map(o => o.customer).filter(Boolean))];
				if (!customers.length) {
					this.current_page = 1;
					this.render_view();
					return;
				}
				frappe.call({
					method: 'frappe.client.get_list',
					args: {
						doctype: 'Customer',
						fields: ['name', 'custom_location'],
						filters: [['name', 'in', customers]],
						limit_page_length: customers.length,
					},
					callback: (rc) => {
						const loc_map = {};
						(rc.message || []).forEach(c => { loc_map[c.name] = c.custom_location || ''; });
						this.orders.forEach(o => { o.custom_location = loc_map[o.customer] || ''; });
						this.current_page = 1;
						this.render_view();
					},
					error: () => { this.current_page = 1; this.render_view(); },
				});
			},
			error: () => { this.current_page = 1; this.render_view(); },
		});
	}

	get_filtered_orders() {
		let orders = this._regions.size
			? this.orders.filter(o => this._regions.has(o.custom_delivery_region))
			: this.orders;
		if (this.search_term) {
			const q = this.search_term.toLowerCase();
			orders = orders.filter(o =>
				(o.name          || '').toLowerCase().includes(q) ||
				(o.customer_name || '').toLowerCase().includes(q) ||
				(o.customer      || '').toLowerCase().includes(q) ||
				(o.sales_persons || '').toLowerCase().includes(q)
			);
		}
		return orders;
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	render_view() {
		const orders     = this.get_filtered_orders();
		const unassigned = orders.filter(o => !o.custom_truck_number);
		const assigned   = orders.filter(o => o.custom_truck_number);
		const total_val  = orders.reduce((s, o) => s + (o.grand_total || 0), 0);
		const trucks_used = new Set(assigned.map(o => o.custom_truck_number)).size;

		let html = `
		<div class="ta-kpi-row">
			${this._kpi('Total Orders',   orders.length,                '#667eea')}
			${this._kpi('Unassigned',     unassigned.length,            unassigned.length > 0 ? '#ef4444' : '#10b981')}
			${this._kpi('Assigned',       assigned.length,              '#10b981')}
			${this._kpi('Total Value',    format_currency(total_val),   '#f59e0b')}
			${this._kpi('Trucks Active',  trucks_used,                  '#8b5cf6')}
		</div>

		${(this.available_trucks.length || this.closed_trucks.length) ? `
		<div class="ta-section">
			<div class="ta-section-header">
				Trucks
				<span class="ta-count-badge">${trucks_used} loaded${this.closed_trucks.length ? ` &nbsp;·&nbsp; ${this.closed_trucks.length} trips today` : ''}</span>
			</div>
			${this.search_term ? this._render_search_truck_results(orders) : `
			<div class="ta-subtabs">
				<button class="ta-subtab-btn ${this.trucks_tab === 'active' ? 'active' : ''}" data-tab="active">
					Active
					<span class="ta-subtab-badge">${trucks_used}</span>
				</button>
				<button class="ta-subtab-btn ${this.trucks_tab === 'dispatched' ? 'active' : ''}" data-tab="dispatched">
					Trip History
					${this.closed_trucks.length ? `<span class="ta-subtab-badge" style="background:#64748b;">${this.closed_trucks.length}</span>` : ''}
				</button>
			</div>
			${this.trucks_tab === 'active' ? this._render_trucks(this.orders) : this._render_dispatched_trucks()}`}
		</div>` : ''}

		<div class="ta-section">
			<div class="ta-section-header">
				Orders Awaiting Assignment
				<span class="ta-count-badge">${unassigned.length}</span>
			</div>
			${this._render_awaiting(unassigned)}
		</div>

		${this._styles()}`;

		this.container.html(html);
		this._attach_events();
	}

	_save_truck_meta() {
		const data = this.available_trucks.map(t => ({
			truck_number: t.truck_number,
			driver_name:  t.driver_name  || '',
			capacity_kg:  t.capacity_kg  != null ? t.capacity_kg : 5000,
			trip_id:      t.trip_id      || '',
		}));
		// Update in-memory saved_meta so subsequent seeds in load_data() use fresh values
		this.saved_meta = {};
		data.forEach(t => { this.saved_meta[t.truck_number] = t; });

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.save_truck_meta',
			args: { trucks_json: JSON.stringify(data) },
		});
	}

	_kpi(label, value, color) {
		return `<div class="ta-kpi" style="border-top:4px solid ${color}">
			<div class="ta-kpi-label">${label}</div>
			<div class="ta-kpi-value" style="color:${color}">${value}</div>
		</div>`;
	}

	_loading_html() {
		return `<div style="text-align:center;padding:60px;" class="text-muted">
			<i class="fa fa-spinner fa-spin fa-2x"></i><br><br>Loading…
		</div>`;
	}

	_render_awaiting(all_orders) {
		if (!all_orders.length) {
			return '<div class="ta-empty">All orders have been assigned to trucks.</div>';
		}

		const total_pages = Math.ceil(all_orders.length / this.page_size) || 1;
		if (this.current_page > total_pages) this.current_page = total_pages;
		const page_orders = all_orders.slice(
			(this.current_page - 1) * this.page_size,
			this.current_page * this.page_size
		);

		// Group by delivery region, sorted A-Z, unspecified last
		const groups = {};
		page_orders.forEach(o => {
			const key = o.custom_delivery_region || '__none__';
			if (!groups[key]) groups[key] = [];
			groups[key].push(o);
		});
		const sorted_keys = Object.keys(groups).sort((a, b) => {
			if (a === '__none__') return 1;
			if (b === '__none__') return -1;
			return a.localeCompare(b);
		});

		const truck_opts = this.available_trucks.map(t =>
			`<option value="${frappe.utils.escape_html(t.truck_number)}">`
		).join('');

		// Count selected orders visible in the full filtered list (all pages)
		const sel_count   = all_orders.filter(o => this.selected_orders.has(o.name)).length;
		const all_checked = all_orders.length > 0 && sel_count === all_orders.length;

		let html = `
		<datalist id="ta-trucks-list">${truck_opts}</datalist>

		<div class="ta-bulk-bar">
			<label class="ta-bulk-select-label">
				<input type="checkbox" class="ta-select-all-chk" ${all_checked ? 'checked' : ''}>
				Select all
			</label>
			<span class="ta-bulk-sep"></span>
			<span class="ta-bulk-count">${sel_count} of ${all_orders.length} selected</span>
			<div class="ta-bulk-actions">
				<input type="text" class="ta-bulk-truck-input form-control form-control-sm"
				       list="ta-trucks-list" placeholder="Assign to truck…"
				       ${!sel_count ? 'disabled' : ''}>
				<button class="btn btn-sm btn-primary ta-bulk-assign-btn" ${!sel_count ? 'disabled' : ''}>
					Assign
				</button>
				${sel_count ? `<button class="btn btn-sm btn-default ta-bulk-clear-btn">Clear</button>` : ''}
			</div>
		</div>

		<div class="ta-table-wrap">
		<table class="table table-bordered ta-table">
			<thead><tr>
				<th width="3%"></th>
				<th width="11%">Sales Order</th>
				<th width="12%">Customer</th>
				<th width="9%">Location</th>
				<th width="7%">Region</th>
				<th width="7%">Value</th>
				<th width="6%">Weight</th>
				<th width="8%">Status</th>
				<th width="12%">Assign Truck</th>
				<th width="7%">Pre-Fulfilment</th>
			</tr></thead>
			<tbody>`;

		sorted_keys.forEach(key => {
			const label   = key === '__none__' ? 'No Region' : key;
			const grp     = groups[key];
			const grp_val = grp.reduce((s, o) => s + (o.grand_total || 0), 0);

			html += `<tr class="ta-group-row">
				<td colspan="10">
					<strong>${label}</strong>
					<span class="ta-group-meta">${grp.length} order${grp.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ${format_currency(grp_val)}</span>
				</td>
			</tr>`;

			grp.forEach(o => {
				const not_picked = o.custom_call_not_picked === 1;
				const checked    = this.selected_orders.has(o.name);
				const is_pf      = o.custom_is_pre_fulfillment == 1;
				html += `
				<tr class="ta-row${not_picked ? ' ta-row-warn' : ''}${checked ? ' ta-row-selected' : ''}${is_pf ? ' ta-row-pf' : ''}" data-order="${o.name}">
					<td class="ta-td-chk">
						<input type="checkbox" class="ta-order-chk" data-order="${o.name}" ${checked ? 'checked' : ''}>
					</td>
					<td>
						<a href="/app/sales-order/${o.name}" target="_blank">${o.name}</a>
						${not_picked ? '<span class="ta-warn-badge" title="Call not picked">!</span>' : ''}
					</td>
					<td title="${frappe.utils.escape_html(o.customer)}">
						${frappe.utils.escape_html(o.customer_name || o.customer)}
						${not_picked && o.custom_call_notes ? `<br><small class="ta-note">${frappe.utils.escape_html(o.custom_call_notes)}</small>` : ''}
					</td>
					<td>${o.custom_location ? frappe.utils.escape_html(o.custom_location) : '<span class="text-muted">—</span>'}</td>
					<td>${o.custom_delivery_region || '—'}</td>
					<td class="ta-amt">${format_currency(o.grand_total)}</td>
					<td class="ta-amt">${(o.total_net_weight || 0).toFixed(1)} kg</td>
					<td>${this._state_badge(o.workflow_state)}</td>
					<td>
						<input type="text"
							   class="ta-truck-input form-control form-control-sm"
							   list="ta-trucks-list"
							   placeholder="Truck number…"
							   data-order="${o.name}"
							   value="${frappe.utils.escape_html(o.custom_truck_number || '')}">
					</td>
					<td style="text-align:center;">
						<button class="btn btn-xs ta-pf-btn"
						        data-order="${o.name}" data-pf="${is_pf ? 1 : 0}"
						        title="${is_pf ? 'Pre-Fulfilment — click to remove' : 'Mark as Pre-Fulfilment'}"
						        style="${is_pf ? 'background:#0d9488;color:#fff;border-color:#0d9488;' : 'background:#f1f5f9;color:#64748b;border-color:#cbd5e1;'}">
							${is_pf ? '&#128205; On' : 'Off'}
						</button>
					</td>
				</tr>`;
			});
		});

		html += `</tbody></table>
		${this._pagination_html(all_orders.length)}
		</div>`;
		return html;
	}

	_pagination_html(total) {
		if (total <= this.page_size) return '';
		const total_pages = Math.ceil(total / this.page_size);
		const start = (this.current_page - 1) * this.page_size + 1;
		const end   = Math.min(this.current_page * this.page_size, total);
		return `<div class="ta-pg-bar">
			<button class="btn btn-xs btn-default ta-pg-prev" ${this.current_page <= 1 ? 'disabled' : ''}>&lsaquo; Prev</button>
			<span class="ta-pg-info">Showing ${start}–${end} of ${total} &nbsp;·&nbsp; Page ${this.current_page} of ${total_pages}</span>
			<button class="btn btn-xs btn-default ta-pg-next" ${this.current_page >= total_pages ? 'disabled' : ''}>Next &rsaquo;</button>
		</div>`;
	}

	_state_badge(state) {
		const map = {
			'Pending Finance Approval':              ['#f59e0b', 'Finance'],
			'Pending Customer Order Reconfirmation': ['#3b82f6', 'Confirming'],
			'Order Confirmed':                       ['#10b981', 'Confirmed'],
		};
		const [color, label] = map[state] || ['#9ca3af', state || '—'];
		return `<span class="ta-state-badge" style="background:${color}">${label}</span>`;
	}

	_render_search_truck_results(matched_orders) {
		const assigned_matches = matched_orders.filter(o => o.custom_truck_number);
		if (!assigned_matches.length) return '<div class="ta-empty">No assigned orders match this search.</div>';

		// Build a map of truck_number → truck meta (active + dispatched)
		const all_truck_meta = {};
		this.available_trucks.forEach(t => { all_truck_meta[t.truck_number] = t; });
		this.closed_trucks.forEach(t => { all_truck_meta[t.truck_number] = t; });
		const closed_set = new Set(this.closed_trucks.map(t => t.truck_number));

		const truck_numbers = [...new Set(assigned_matches.map(o => o.custom_truck_number))];
		let html = '<div class="ta-trucks-grid">';
		truck_numbers.forEach(tn => {
			const truck = all_truck_meta[tn] || { truck_number: tn };
			const is_dispatched = closed_set.has(tn);
			const truck_orders = assigned_matches.filter(o => o.custom_truck_number === tn);
			const total_weight = truck_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
			const total_value  = truck_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
			html += `
			<div class="ta-truck-card" style="${is_dispatched ? 'opacity:0.75;border-top:4px solid #64748b;' : ''}">
				<div class="ta-truck-head">
					<div class="ta-truck-num">${frappe.utils.escape_html(tn)}
						${is_dispatched ? '<span style="font-size:10px;font-weight:400;color:#64748b;margin-left:6px;">Dispatched</span>' : ''}
					</div>
				</div>
				${truck.driver_name ? `<div class="ta-truck-driver">${frappe.utils.escape_html(truck.driver_name)}</div>` : ''}
				<div class="ta-truck-stats">
					<div class="ta-truck-stat"><span>${truck_orders.length}</span>Matched Orders</div>
					<div class="ta-truck-stat"><span>${total_weight.toFixed(0)} kg</span>Weight</div>
					<div class="ta-truck-stat"><span>${format_currency(total_value, null, 0)}</span>Value</div>
				</div>
				<div class="ta-truck-orders">
					${truck_orders.map(o => `
					<div class="ta-truck-order" style="background:#fef9c3;">
						<div>
							<a href="/app/sales-order/${o.name}" target="_blank" class="ta-order-link">${o.name}</a>
							<span class="ta-order-cust">${frappe.utils.escape_html(o.customer_name || o.customer)}</span>
						</div>
						<div style="font-size:11px;color:#64748b;">${frappe.utils.escape_html(o.custom_delivery_region || '')}</div>
					</div>`).join('')}
				</div>
			</div>`;
		});
		html += '</div>';
		return html;
	}

	_render_trucks(all_orders) {
		if (!this.available_trucks.length) return '';

		let html = '<div class="ta-trucks-grid">';

		this.available_trucks.forEach(truck => {
			const truck_orders = all_orders.filter(o => o.custom_truck_number === truck.truck_number);
			const total_weight = truck_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
			const total_value  = truck_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
			const capacity     = truck.capacity_kg || 0;
			const cap_pct      = capacity > 0 ? Math.min((total_weight / capacity) * 100, 100).toFixed(0) : 0;
			const is_empty     = !truck_orders.length;
			const not_picked   = truck_orders.filter(o => o.custom_call_not_picked === 1).length;
			const regions      = [...new Set(truck_orders.map(o => o.custom_delivery_region).filter(Boolean))].sort();

			html += `
			<div class="ta-truck-card${is_empty ? ' ta-truck-empty' : ''}">
				<div class="ta-truck-head">
					<div>
						<div class="ta-truck-num">${frappe.utils.escape_html(truck.truck_number)}</div>
						${truck.trip_id ? `<div style="font-size:10px;color:#94a3b8;letter-spacing:.5px;">${frappe.utils.escape_html(truck.trip_id)}</div>` : ''}
					</div>
					<div class="ta-truck-btns">
						<button class="btn btn-xs btn-default btn-dl-manifest"   data-truck="${truck.truck_number}" title="Download manifest">&#8659;</button>
						<button class="btn btn-xs btn-default btn-edit-truck"    data-truck="${truck.truck_number}" title="Edit">&#9998;</button>
						${!is_empty ? `<button class="btn btn-xs btn-default btn-reassign-truck" data-truck="${truck.truck_number}" title="Move all orders to another truck">&#8644;</button>` : ''}
						<button class="btn btn-xs btn-danger  btn-delete-truck"  data-truck="${truck.truck_number}" title="${is_empty ? 'Remove truck' : 'Unassign all orders'}">&#215;</button>
						${!is_empty ? `<button class="btn btn-xs btn-primary btn-close-truck" data-truck="${truck.truck_number}">Dispatch</button>` : ''}
					</div>
				</div>

				${truck.driver_name ? `<div class="ta-truck-driver">${frappe.utils.escape_html(truck.driver_name)}</div>` : ''}
				${not_picked ? `<div class="ta-truck-warn">${not_picked} customer(s) did not answer — driver should contact on arrival</div>` : ''}

				${!is_empty ? `
				<div class="ta-truck-stats">
					<div class="ta-truck-stat"><span>${truck_orders.length}</span>Orders</div>
					<div class="ta-truck-stat"><span>${total_weight.toFixed(0)} kg</span>Weight</div>
					<div class="ta-truck-stat"><span>${format_currency(total_value, null, 0)}</span>Value</div>
				</div>
				${capacity > 0 ? `
				<div class="ta-cap-bar">
					<div class="ta-cap-fill" style="width:${cap_pct}%;background:${cap_pct > 90 ? '#ef4444' : '#10b981'}"></div>
				</div>
				<div class="ta-cap-label">${cap_pct}% capacity (${total_weight.toFixed(0)} / ${capacity} kg)</div>
				` : ''}
				${regions.length ? `<div class="ta-truck-routes">${regions.map(r => `<span class="ta-route-tag">${r}</span>`).join('')}</div>` : ''}
				<div class="ta-truck-orders">
					${truck_orders.map(o => `
					<div class="ta-truck-order">
						<div>
							<a href="/app/sales-order/${o.name}" target="_blank" class="ta-order-link">${o.name}</a>
							<span class="ta-order-cust">${frappe.utils.escape_html(o.customer_name || o.customer)}</span>
							${o.custom_location ? `<span class="ta-order-loc">${frappe.utils.escape_html(o.custom_location)}</span>` : ''}
						</div>
						<button class="btn btn-xs btn-default btn-unassign" data-order="${o.name}" title="Remove from truck">&#215;</button>
					</div>`).join('')}
				</div>
				` : '<div class="ta-empty-truck">No orders assigned</div>'}
			</div>`;
		});

		html += '</div>';
		return html;
	}

	_render_dispatched_trucks() {
		if (!this.closed_trucks.length) {
			return `<div style="padding:24px;text-align:center;color:#94a3b8;">No trips recorded yet.</div>`;
		}

		let html = '<div class="ta-trucks-grid">';

		this.closed_trucks.forEach((ct, idx) => {
			const closed_label = ct.closed_at
				? frappe.datetime.str_to_user(ct.closed_at.split(' ')[0]) + ' ' + (ct.closed_at.split(' ')[1] || '').slice(0, 5)
				: '—';

			const order_rows = (ct.orders || []).map(o => `
			<div class="ta-truck-order">
				<div>
					<a href="/app/sales-order/${o.name}" target="_blank" class="ta-order-link">${frappe.utils.escape_html(o.name)}</a>
					<span class="ta-order-cust">${frappe.utils.escape_html(o.customer_name || '')}</span>
					${o.delivery_region ? `<span class="ta-order-loc">${frappe.utils.escape_html(o.delivery_region)}</span>` : ''}
				</div>
			</div>`).join('');

			html += `
			<div class="ta-truck-card ta-closed-card">
				<div class="ta-truck-head" style="background:#475569;">
					<div>
						<div class="ta-truck-num">&#10003; ${frappe.utils.escape_html(ct.truck_number)}</div>
						${ct.driver_name ? `<div class="ta-truck-driver" style="color:#cbd5e1;">${frappe.utils.escape_html(ct.driver_name)}</div>` : ''}
						${ct.trip_id ? `<div style="font-size:10px;color:#94a3b8;letter-spacing:.5px;">${frappe.utils.escape_html(ct.trip_id)}</div>` : ''}
					</div>
					<div style="text-align:right;">
						<div style="font-size:11px;color:#94a3b8;">${frappe.utils.escape_html(closed_label)}</div>
					</div>
				</div>

				<div class="ta-truck-stats">
					<div class="ta-truck-stat"><span>${ct.order_count}</span>Orders</div>
					<div class="ta-truck-stat"><span>${(ct.total_weight || 0).toFixed(0)} kg</span>Weight</div>
					<div class="ta-truck-stat"><span>${format_currency(ct.total_value || 0, null, 0)}</span>Value</div>
				</div>

				<div class="ta-orders-section">
					<div class="ta-closed-toggle" data-idx="${idx}">
						&#9658; View ${(ct.orders || []).length} order${(ct.orders || []).length !== 1 ? 's' : ''}
					</div>
					<div class="ta-closed-orders-list" id="ta-closed-orders-${idx}" style="display:none;">
						${order_rows}
					</div>
				</div>
			</div>`;
		});

		html += '</div>';
		return html;
	}

	// ── Events ────────────────────────────────────────────────────────────────

	_attach_events() {
		const self = this;

		// ── Bulk selection ────────────────────────────────────────────────────────

		// Select all (across all pages of filtered unassigned orders)
		this.container.find('.ta-select-all-chk').on('change', function () {
			const checked    = $(this).is(':checked');
			const unassigned = self.get_filtered_orders().filter(o => !o.custom_truck_number);
			unassigned.forEach(o => checked ? self.selected_orders.add(o.name) : self.selected_orders.delete(o.name));
			self.render_view();
		});

		// Trucks sub-tab switching (Active / Dispatched)
		this.container.off('click.ta-stab').on('click.ta-stab', '.ta-subtab-btn', function () {
			self.trucks_tab = $(this).data('tab');
			self.render_view();
		});

		// Individual row checkbox — update in place, no full re-render
		this.container.find('.ta-order-chk').on('change', function () {
			const name    = $(this).data('order');
			const checked = $(this).is(':checked');
			checked ? self.selected_orders.add(name) : self.selected_orders.delete(name);

			$(this).closest('tr').toggleClass('ta-row-selected', checked);

			// Update count label and button state
			const unassigned  = self.get_filtered_orders().filter(o => !o.custom_truck_number);
			const sel_count   = unassigned.filter(o => self.selected_orders.has(o.name)).length;
			const all_checked = sel_count === unassigned.length && unassigned.length > 0;

			self.container.find('.ta-select-all-chk').prop('checked', all_checked);
			self.container.find('.ta-bulk-count').text(`${sel_count} of ${unassigned.length} selected`);
			self.container.find('.ta-bulk-assign-btn').prop('disabled', sel_count === 0);
			self.container.find('.ta-bulk-truck-input').prop('disabled', sel_count === 0);

			// Show/hide Clear button
			if (sel_count > 0 && !self.container.find('.ta-bulk-clear-btn').length) {
				self.container.find('.ta-bulk-assign-btn').after(
					'<button class="btn btn-sm btn-default ta-bulk-clear-btn" style="margin-left:6px">Clear</button>'
				);
				self.container.find('.ta-bulk-clear-btn').on('click', () => {
					self.selected_orders.clear();
					self.render_view();
				});
			} else if (sel_count === 0) {
				self.container.find('.ta-bulk-clear-btn').remove();
			}
		});

		// Bulk assign button
		this.container.find('.ta-bulk-assign-btn').on('click', function () {
			const truck_number = self.container.find('.ta-bulk-truck-input').val().trim();
			if (!truck_number) {
				frappe.msgprint(__('Enter a truck number to assign to.'));
				return;
			}
			self._bulk_assign(truck_number);
		});

		// Bulk truck input: also trigger assign on Enter
		this.container.find('.ta-bulk-truck-input').on('keydown', function (e) {
			if (e.key === 'Enter') self.container.find('.ta-bulk-assign-btn').trigger('click');
		});

		// Clear button (rendered when sel_count > 0 at render time)
		this.container.find('.ta-bulk-clear-btn').on('click', function () {
			self.selected_orders.clear();
			self.render_view();
		});

		// ── Per-row truck assignment ───────────────────────────────────────────────

		// Truck assignment via text input (on change / blur)
		this.container.find('.ta-truck-input').off('change').on('change', function () {
			const order_name   = $(this).data('order');
			const truck_number = $(this).val().trim();
			if (truck_number && !self.available_trucks.find(t => t.truck_number === truck_number)) {
				const m = self.saved_meta[truck_number] || {};
				self.available_trucks.push({
					truck_number,
					driver_name: m.driver_name || '',
					capacity_kg: m.capacity_kg != null ? m.capacity_kg : 5000,
					trip_id:     m.trip_id     || self._gen_trip_id(),
				});
			}
			self._set_truck(order_name, truck_number);
		});

		// Also assign on Enter key
		this.container.find('.ta-truck-input').off('keydown').on('keydown', function (e) {
			if (e.key === 'Enter') $(this).trigger('change');
		});

		// Pagination
		this.container.find('.ta-pg-prev').on('click', () => {
			if (this.current_page > 1) { this.current_page--; this.render_view(); }
		});
		this.container.find('.ta-pg-next').on('click', () => {
			const unassigned = this.get_filtered_orders().filter(o => !o.custom_truck_number);
			const tp = Math.ceil(unassigned.length / this.page_size);
			if (this.current_page < tp) { this.current_page++; this.render_view(); }
		});

		this.container.find('.btn-unassign').off('click').on('click', function () {
			self._set_truck($(this).data('order'), '');
		});

		this.container.find('.btn-edit-truck').off('click').on('click', function () {
			self.edit_truck_details($(this).data('truck'));
		});

		this.container.find('.btn-reassign-truck').off('click').on('click', function () {
			self.reassign_truck_orders($(this).data('truck'));
		});

		this.container.find('.btn-delete-truck').off('click').on('click', function () {
			self.delete_truck($(this).data('truck'));
		});

		this.container.find('.btn-close-truck').off('click').on('click', function () {
			self.close_truck($(this).data('truck'));
		});

		this.container.find('.btn-dl-manifest').off('click').on('click', function () {
			self.download_manifest($(this).data('truck'));
		});

		// Closed truck order list toggle
		this.container.off('click.ta-closed').on('click.ta-closed', '.ta-closed-toggle', function () {
			const idx   = $(this).data('idx');
			const $list = $(`#ta-closed-orders-${idx}`);
			const open  = $list.is(':visible');
			$list.slideToggle(150);
			const ct = self.closed_trucks[idx] || {};
			const n  = (ct.orders || []).length;
			$(this).html(`${open ? '&#9658;' : '&#9660;'} View ${n} order${n !== 1 ? 's' : ''}`);
		});

		this.container.find('.ta-pf-btn').off('click').on('click', function () {
			const $btn    = $(this);
			const order   = $btn.data('order');
			const cur_pf  = parseInt($btn.data('pf'), 10);
			const new_val = cur_pf ? 0 : 1;
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.set_pre_fulfillment',
				args: { order_name: order, value: new_val },
				callback: () => {
					const o = self.orders.find(x => x.name === order);
					if (o) o.custom_is_pre_fulfillment = new_val;
					$btn.data('pf', new_val);
					if (new_val) {
						$btn.css({ background: '#0d9488', color: '#fff', 'border-color': '#0d9488' })
						    .attr('title', 'Pre-Fulfilment — click to remove')
						    .html('&#128205; On');
						$btn.closest('tr').addClass('ta-row-pf');
					} else {
						$btn.css({ background: '#f1f5f9', color: '#64748b', 'border-color': '#cbd5e1' })
						    .attr('title', 'Mark as Pre-Fulfilment')
						    .html('Off');
						$btn.closest('tr').removeClass('ta-row-pf');
					}
					frappe.show_alert({
						message: new_val ? __('Marked as Pre-Fulfilment') : __('Pre-Fulfilment removed'),
						indicator: new_val ? 'green' : 'blue',
					});
				},
			});
		});
	}

	// ── Bulk assignment ───────────────────────────────────────────────────────

	_bulk_assign(truck_number) {
		const unassigned = this.get_filtered_orders().filter(o => !o.custom_truck_number);
		const to_assign  = unassigned.filter(o => this.selected_orders.has(o.name));

		if (!to_assign.length) {
			frappe.msgprint(__('No selected orders to assign.'));
			return;
		}

		if (!this.available_trucks.find(t => t.truck_number === truck_number)) {
			const m = this.saved_meta[truck_number] || {};
			this.available_trucks.push({
				truck_number,
				driver_name: m.driver_name || '',
				capacity_kg: m.capacity_kg != null ? m.capacity_kg : 5000,
				trip_id:     m.trip_id     || this._gen_trip_id(),
			});
		}

		const over = this._check_capacity(truck_number, to_assign);
		if (over) {
			frappe.msgprint({
				title: __('Truck Over Capacity'),
				message: __(
					'Cannot assign {0} order(s) to truck <strong>{1}</strong>.<br>' +
					'Current load: <strong>{2} kg</strong><br>' +
					'These orders add: <strong>{3} kg</strong><br>' +
					'Total would be: <strong>{4} kg</strong> — exceeds capacity of <strong>{5} kg</strong>.',
					[to_assign.length, truck_number,
					 over.current.toFixed(0), over.adding.toFixed(0),
					 over.total.toFixed(0), over.capacity.toFixed(0)]
				),
				indicator: 'red',
			});
			return;
		}

		frappe.confirm(
			__('Assign {0} order(s) to truck {1}?', [to_assign.length, truck_number]),
			() => {
				this._set_truck_batch(to_assign, truck_number, () => {
					this.selected_orders.clear();
					frappe.show_alert({
						message: __('✓ {0} orders assigned to {1}', [to_assign.length, truck_number]),
						indicator: 'green',
					});
					this.load_data();
				});
			}
		);
	}

	// ── Backend calls ─────────────────────────────────────────────────────────

	_check_capacity(truck_number, orders_to_add) {
		const truck    = this.available_trucks.find(t => t.truck_number === truck_number);
		const capacity = truck ? (truck.capacity_kg || 0) : 0;
		if (!capacity) return null; // no limit configured

		const names_to_add = new Set(orders_to_add.map(o => (typeof o === 'string' ? o : o.name)));
		const current_weight = this.orders
			.filter(o => o.custom_truck_number === truck_number && !names_to_add.has(o.name))
			.reduce((s, o) => s + (o.total_net_weight || 0), 0);
		const adding_weight = orders_to_add.reduce((s, o) => {
			if (typeof o === 'string') {
				const found = this.orders.find(x => x.name === o);
				return s + ((found && found.total_net_weight) || 0);
			}
			return s + (o.total_net_weight || 0);
		}, 0);
		const total = current_weight + adding_weight;
		if (total > capacity) {
			return { current: current_weight, adding: adding_weight, total, capacity };
		}
		return null;
	}

	_set_truck(order_name, truck_number) {
		if (truck_number) {
			const over = this._check_capacity(truck_number, [order_name]);
			if (over) {
				frappe.msgprint({
					title: __('Truck Over Capacity'),
					message: __(
						'Cannot assign order to truck <strong>{0}</strong>.<br>' +
						'Current load: <strong>{1} kg</strong><br>' +
						'This order adds: <strong>{2} kg</strong><br>' +
						'Total would be: <strong>{3} kg</strong> — exceeds capacity of <strong>{4} kg</strong>.',
						[truck_number,
						 over.current.toFixed(0), over.adding.toFixed(0),
						 over.total.toFixed(0), over.capacity.toFixed(0)]
					),
					indicator: 'red',
				});
				this.render_view(); // reset the input dropdown
				return;
			}
		}
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.set_truck_number',
			args: { order_name, truck_number },
			callback: () => {
				frappe.show_alert({
					message: truck_number ? __('Assigned to {0}', [truck_number]) : __('Truck unassigned'),
					indicator: truck_number ? 'green' : 'orange',
				});
				this.load_data();
			},
		});
	}

	_set_truck_batch(orders, truck_number, on_done) {
		let done = 0;
		const next = () => {
			if (done >= orders.length) {
				if (on_done) on_done();
				else {
					frappe.show_alert({ message: __('Done — {0} orders updated', [orders.length]), indicator: 'green' });
					this.load_data();
				}
				return;
			}
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.set_truck_number',
				args: { order_name: orders[done].name, truck_number },
				callback: () => { done++; next(); },
				error:    () => { done++; next(); },
			});
		};
		next();
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	edit_truck_details(truck_number) {
		const truck = this.available_trucks.find(t => t.truck_number === truck_number);
		frappe.prompt([
			{ label: 'Truck Number', fieldname: 'truck_number', fieldtype: 'Data',  default: truck.truck_number, reqd: 1 },
			{ label: 'Driver Name',  fieldname: 'driver_name',  fieldtype: 'Data',  default: truck.driver_name },
			{ label: 'Capacity (kg)', fieldname: 'capacity_kg', fieldtype: 'Float', default: truck.capacity_kg || 5000 },
		], (vals) => {
			const old_num = truck.truck_number;
			truck.truck_number = vals.truck_number;
			truck.driver_name  = vals.driver_name;
			truck.capacity_kg  = vals.capacity_kg;
			this._save_truck_meta();
			if (old_num !== vals.truck_number) {
				const to_update = this.orders.filter(o => o.custom_truck_number === old_num);
				if (to_update.length) {
					this._set_truck_batch(to_update, vals.truck_number);
				} else {
					this.render_view();
				}
			} else {
				this.render_view();
			}
			frappe.show_alert({ message: __('Truck updated'), indicator: 'green' });
		}, __('Edit Truck'), __('Update'));
	}

	reassign_truck_orders(truck_number) {
		const truck_orders  = this.orders.filter(o => o.custom_truck_number === truck_number);
		const other_trucks  = this.available_trucks.filter(t => t.truck_number !== truck_number);
		if (!other_trucks.length) {
			frappe.msgprint(__('No other trucks available. Add another truck first.'));
			return;
		}
		frappe.prompt([{
			label: 'Move all orders to',
			fieldname: 'new_truck',
			fieldtype: 'Select',
			options: other_trucks.map(t => t.truck_number + (t.driver_name ? ' — ' + t.driver_name : '')).join('\n'),
			reqd: 1,
		}], (vals) => {
			const new_truck = vals.new_truck.split(' — ')[0];
			this._set_truck_batch(truck_orders, new_truck);
		}, __('Reassign from {0}', [truck_number]), __('Move'));
	}

	delete_truck(truck_number) {
		const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
		if (!truck_orders.length) {
			this.available_trucks = this.available_trucks.filter(t => t.truck_number !== truck_number);
			this._save_truck_meta();
			frappe.show_alert({ message: __('Truck removed'), indicator: 'green' });
			this.render_view();
		} else {
			frappe.confirm(
				__('Unassign {0} orders from {1}? They will return to the unassigned list.', [truck_orders.length, truck_number]),
				() => this._set_truck_batch(truck_orders, '')
			);
		}
	}

	close_truck(truck_number) {
		const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
		if (!truck_orders.length) { frappe.msgprint(__('Cannot close an empty truck')); return; }

		const unsubmitted = truck_orders.filter(o => parseInt(o.docstatus) === 0);
		const msg = unsubmitted.length
			? __('Truck {0} has {1} unsubmitted order(s). Dispatch anyway? Trip will be recorded and truck cleared for the next load.', [truck_number, unsubmitted.length])
			: __('Dispatch truck {0} with {1} orders? Trip will be recorded and truck cleared for the next load.', [truck_number, truck_orders.length]);

		frappe.confirm(msg, () => {
			this.download_manifest(truck_number);
			this._close_truck_batch(truck_number, truck_orders);
		});
	}

	_close_truck_batch(truck_number, truck_orders) {
		const truck_info = this.available_trucks.find(t => t.truck_number === truck_number) || {};
		const closure = {
			trip_id:      truck_info.trip_id || '',
			truck_number,
			driver_name:  truck_info.driver_name || '',
			capacity_kg:  truck_info.capacity_kg || 0,
			closed_at:    frappe.datetime.now_datetime(),
			order_count:  truck_orders.length,
			total_weight: truck_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0),
			total_value:  truck_orders.reduce((s, o) => s + (o.grand_total || 0), 0),
			orders: truck_orders.map(o => ({
				name:            o.name,
				customer_name:   o.customer_name || o.customer,
				delivery_region: o.custom_delivery_region || '',
			})),
		};

		// Single batch call — marks all orders closed atomically in one SQL UPDATE
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.close_truck_orders',
			args: { order_names_json: JSON.stringify(truck_orders.map(o => o.name)) },
			callback: () => {
				// Prepend to trip history and persist
				this.closed_trucks = [closure, ...this.closed_trucks];
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.save_closed_trucks',
					args: { closed_trucks_json: JSON.stringify(this.closed_trucks) },
				});

				// Persist as a submitted Crystal Truck Plan for permanent record
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.create_truck_plan',
					args: {
						truck_number: truck_number,
						driver_name:  truck_info.driver_name || '',
						capacity_kg:  truck_info.capacity_kg || 0,
						orders_json:  JSON.stringify(truck_orders.map(o => ({
							name:             o.name,
							customer_name:    o.customer_name || o.customer || '',
							delivery_region:  o.custom_delivery_region || '',
							grand_total:      o.grand_total || 0,
							total_net_weight: o.total_net_weight || 0,
						}))),
						closed_from: 'Truck Assignment',
					},
				});

				// Remove from active list and persist
				this.available_trucks = this.available_trucks.filter(t => t.truck_number !== truck_number);
				this._save_truck_meta();

				frappe.show_alert({ message: __('Trip recorded for {0}', [truck_number]), indicator: 'green' });
				this.load_data();
			},
			error: () => {
				frappe.msgprint(__('Failed to dispatch truck {0}. Please try again.', [truck_number]));
			},
		});
	}


	reopen_truck(idx) {
		const ct = this.closed_trucks[idx];
		if (!ct) return;

		frappe.confirm(
			__('Reopen truck {0}? Orders will be restored to active.', [ct.truck_number]),
			() => {
				// Always look up by truck number in the DB — works even for trucks
				// closed before the orders array was stored in the closure record.
				frappe.call({
					method: 'frappe.client.get_list',
					args: {
						doctype: 'Sales Order',
						fields: ['name'],
						filters: [
							['Sales Order', 'custom_truck_number', '=', ct.truck_number],
							['Sales Order', 'custom_truck_closed', '=', 1],
						],
						limit_page_length: 500,
					},
					callback: (r) => {
						const orders = r.message || [];
						let done = 0;
						const finish = () => {
							// Remove from closed history and persist
							this.closed_trucks.splice(idx, 1);
							frappe.call({
								method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.save_closed_trucks',
								args: { closed_trucks_json: JSON.stringify(this.closed_trucks) },
							});

							// Restore to active truck list and persist meta
							if (!this.available_trucks.find(t => t.truck_number === ct.truck_number)) {
								this.available_trucks.push({
									truck_number: ct.truck_number,
									driver_name:  ct.driver_name  || '',
									capacity_kg:  ct.capacity_kg  || 5000,
									trip_id:      this._gen_trip_id(),
								});
								this._save_truck_meta();
							}

							frappe.show_alert({
								message: __('Truck {0} reopened — {1} order(s) restored', [ct.truck_number, orders.length]),
								indicator: 'green',
							});
							this.load_data();
						};

						if (!orders.length) { finish(); return; }

						const next = () => {
							if (done >= orders.length) { finish(); return; }
							frappe.call({
								method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.set_truck_closed',
								args: { order_name: orders[done].name, value: 0 },
								callback: () => { done++; next(); },
								error:    () => { done++; next(); },
							});
						};
						next();
					},
					error: () => frappe.msgprint(__('Could not load orders for truck {0}', [ct.truck_number])),
				});
			}
		);
	}

	edit_closed_truck(idx) {
		const ct = this.closed_trucks[idx];
		if (!ct) return;

		frappe.prompt([
			{ label: 'Driver Name',   fieldname: 'driver_name', fieldtype: 'Data',  default: ct.driver_name || '' },
			{ label: 'Capacity (kg)', fieldname: 'capacity_kg', fieldtype: 'Float', default: ct.capacity_kg  || 5000 },
		], (vals) => {
			ct.driver_name = vals.driver_name;
			ct.capacity_kg = vals.capacity_kg;
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.save_closed_trucks',
				args: { closed_trucks_json: JSON.stringify(this.closed_trucks) },
				callback: () => {
					frappe.show_alert({ message: __('Truck {0} updated', [ct.truck_number]), indicator: 'green' });
					this.render_view();
				},
			});
		}, __('Edit Truck {0}', [ct.truck_number]), __('Save'));
	}

	download_manifest(truck_number) {
		const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
		const truck_info   = this.available_trucks.find(t => t.truck_number === truck_number);
		if (!truck_orders.length) { frappe.msgprint(__('No orders in this truck')); return; }

		const total_weight = truck_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
		const total_value  = truck_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
		// Sort by region for manifest readability
		const sorted = [...truck_orders].sort((a, b) =>
			(a.custom_delivery_region || '').localeCompare(b.custom_delivery_region || '')
		);

		const driver_cols = truck_info && truck_info.driver_name
			? `<td style="border:none;font-weight:bold;padding-left:20px">Driver:</td><td style="border:none">${truck_info.driver_name}</td>`
			: '';

		const rows = sorted.map(o => {
			const status = o.docstatus === 1 ? 'Submitted'
				: o.workflow_state === 'Order Confirmed' ? 'Confirmed'
				: o.workflow_state === 'Pending Customer Order Reconfirmation' ? 'Pending Confirm'
				: 'Draft';
			return `<tr>
				<td>${o.name}</td>
				<td>${o.customer_name || o.customer}</td>
				<td>${o.custom_delivery_region || ''}</td>
				<td style="text-align:right">${(o.total_net_weight || 0).toFixed(2)}</td>
				<td style="text-align:right">${o.grand_total.toFixed(2)}</td>
				<td>${status}</td>
				<td style="text-align:center">${o.custom_call_not_picked ? 'YES' : 'NO'}</td>
				<td>${o.custom_call_notes || ''}</td>
			</tr>`;
		}).join('');

		const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
			xmlns:x="urn:schemas-microsoft-com:office:excel"
			xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<style>table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#1e293b;color:#fff;font-weight:bold}</style>
</head><body>
<h2 style="font-family:sans-serif">TRUCK DELIVERY MANIFEST</h2>
<table style="margin-bottom:16px;border:none;font-family:sans-serif"><tr style="border:none">
<td style="border:none;font-weight:bold">Truck:</td><td style="border:none">${truck_number}</td>
${driver_cols}
<td style="border:none;font-weight:bold;padding-left:20px">Date:</td><td style="border:none">${frappe.datetime.now_date()}</td>
<td style="border:none;font-weight:bold;padding-left:20px">Orders:</td><td style="border:none">${truck_orders.length}</td>
<td style="border:none;font-weight:bold;padding-left:20px">Weight:</td><td style="border:none">${total_weight.toFixed(2)} kg</td>
<td style="border:none;font-weight:bold;padding-left:20px">Value:</td><td style="border:none">${total_value.toFixed(2)}</td>
</tr></table>
<table><thead><tr>
<th>Order</th><th>Customer</th><th>Region</th><th>Weight (kg)</th><th>Value</th><th>Status</th><th>Call Issue</th><th>Notes</th>
</tr></thead><tbody>${rows}</tbody></table>
</body></html>`;

		const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `Truck_${truck_number}_${frappe.datetime.now_date()}.xls`;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);

		frappe.show_alert({ message: __('Manifest downloaded for {0}', [truck_number]), indicator: 'green' });
	}

	// ── SP Pills ──────────────────────────────────────────────────────────────

	_render_sp_pills() {
		if (!this._sp_pills_wrap) return;
		if (!this._sps.size) { this._sp_pills_wrap.empty(); return; }
		const self = this;
		const html = Array.from(this._sps).map(sp =>
			`<span class="sp-pill">${frappe.utils.escape_html(sp)}<span class="sp-rm" data-sp="${frappe.utils.escape_html(sp)}">&times;</span></span>`
		).join('');
		this._sp_pills_wrap.html(`<style>.sp-pills-wrap{padding:4px 8px 2px;display:flex;flex-wrap:wrap;gap:4px;min-height:4px;}.sp-pill{background:#dbeafe;color:#1d4ed8;border-radius:12px;padding:2px 8px;font-size:11px;display:inline-flex;align-items:center;gap:3px;}.sp-rm{cursor:pointer;font-size:13px;line-height:1;margin-left:2px;color:#2563eb;font-weight:bold;}</style>${html}`);
		this._sp_pills_wrap.find('.sp-rm').on('click', function () {
			self._sps.delete($(this).data('sp'));
			self._render_sp_pills();
			self.load_data();
		});
	}

	_render_region_pills() {
		if (!this._region_pills_wrap) return;
		if (!this._regions.size) { this._region_pills_wrap.empty(); return; }
		const self = this;
		const html = Array.from(this._regions).map(r =>
			`<span class="rg-pill">${frappe.utils.escape_html(r)}<span class="rg-rm" data-rg="${frappe.utils.escape_html(r)}">&times;</span></span>`
		).join('');
		this._region_pills_wrap.html(`<style>.region-pills-wrap{padding:4px 8px 2px;display:flex;flex-wrap:wrap;gap:4px;min-height:4px;}.rg-pill{background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:12px;padding:2px 8px;font-size:11px;display:inline-flex;align-items:center;gap:3px;}.rg-rm{cursor:pointer;font-size:13px;line-height:1;margin-left:2px;color:#16a34a;font-weight:bold;}</style>${html}`);
		this._region_pills_wrap.find('.rg-rm').on('click', function () {
			self._regions.delete($(this).data('rg'));
			self._render_region_pills();
			self.current_page = 1; self.render_view();
		});
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	_styles() {
		return `<style>
		.ta-container { margin-top: 16px; }

		/* Search bar */
		.ta-search-row {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 16px;
		}
		.ta-search-input {
			max-width: 340px;
			height: 34px;
			font-size: 13px;
			border-radius: 6px;
		}
		.ta-search-count {
			font-size: 12px;
			color: #6b7280;
			white-space: nowrap;
		}

		/* KPI row */
		.ta-kpi-row {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
			gap: 16px;
			margin-bottom: 24px;
		}
		.ta-kpi {
			background: #fff;
			border-radius: 8px;
			padding: 16px 20px;
			box-shadow: 0 1px 6px rgba(0,0,0,.07);
		}
		.ta-kpi-label { font-size: 12px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
		.ta-kpi-value { font-size: 22px; font-weight: 700; margin-top: 6px; }

		/* Sections */
		.ta-section {
			background: #fff;
			border-radius: 8px;
			padding: 16px;
			box-shadow: 0 1px 6px rgba(0,0,0,.07);
			margin-bottom: 24px;
		}
		.ta-section-header {
			font-size: 14px;
			font-weight: 700;
			color: #1e293b;
			margin-bottom: 16px;
			padding-bottom: 8px;
			border-bottom: 2px solid #f1f5f9;
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.ta-count-badge {
			background: #667eea;
			color: #fff;
			border-radius: 12px;
			padding: 1px 9px;
			font-size: 12px;
			font-weight: 600;
		}

		/* Active / Dispatched sub-tabs */
		.ta-subtabs {
			display: flex;
			gap: 4px;
			border-bottom: 2px solid #e2e8f0;
			margin-bottom: 20px;
		}
		.ta-subtab-btn {
			background: none;
			border: none;
			border-bottom: 3px solid transparent;
			margin-bottom: -2px;
			padding: 8px 18px;
			font-weight: 600;
			font-size: 13px;
			color: #6b7280;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 6px;
			outline: none;
			transition: color .2s;
		}
		.ta-subtab-btn:hover { color: #667eea; }
		.ta-subtab-btn.active { color: #667eea; border-bottom-color: #667eea; }
		.ta-subtab-badge {
			background: #667eea;
			color: #fff;
			border-radius: 10px;
			padding: 1px 7px;
			font-size: 11px;
			font-weight: 700;
		}

		/* Bulk assignment bar */
		.ta-bulk-bar {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 10px 14px;
			background: #f8fafc;
			border: 1px solid #e2e8f0;
			border-radius: 6px;
			margin-bottom: 10px;
			flex-wrap: wrap;
		}
		.ta-bulk-select-label {
			display: flex;
			align-items: center;
			gap: 6px;
			font-weight: 600;
			font-size: 13px;
			color: #374151;
			cursor: pointer;
			margin: 0;
			white-space: nowrap;
		}
		.ta-bulk-select-label input { width:15px; height:15px; accent-color:#667eea; cursor:pointer; }
		.ta-bulk-sep { flex: 1; }
		.ta-bulk-count { font-size: 13px; color: #6b7280; white-space: nowrap; }
		.ta-bulk-actions { display: flex; align-items: center; gap: 6px; }
		.ta-bulk-truck-input { width: 160px !important; height: 30px !important; font-size: 12px !important; }
		.ta-td-chk { width: 36px; text-align: center; }
		.ta-row-selected td { background: #eff6ff !important; }

		/* Awaiting table */
		.ta-table-wrap { overflow-x: auto; }
		.ta-table thead th {
			background: #1e293b;
			color: #fff;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: .4px;
			padding: 10px 10px !important;
			border: none !important;
			white-space: nowrap;
		}
		.ta-table .ta-group-row td {
			background: #f8fafc;
			font-size: 12px;
			padding: 6px 10px !important;
			color: #475569;
			border-top: 2px solid #e2e8f0 !important;
		}
		.ta-group-meta { margin-left: 10px; color: #94a3b8; font-weight: normal; }
		.ta-row td { padding: 10px !important; vertical-align: middle !important; font-size: 13px; }
		.ta-row:hover { background: #f8fafc !important; }
		.ta-row-warn { border-left: 3px solid #f59e0b !important; }
		.ta-row-pf td { background: #f0fdfa !important; }
		.ta-row-pf:hover td { background: #ccfbf1 !important; }
		.ta-amt { text-align: right; font-family: monospace; }
		.ta-warn-badge {
			display: inline-block;
			background: #f59e0b;
			color: #fff;
			border-radius: 3px;
			padding: 0 5px;
			font-size: 11px;
			font-weight: 700;
			margin-left: 4px;
			vertical-align: middle;
		}
		.ta-note { color: #92400e; font-style: italic; }
		.ta-state-badge {
			display: inline-block;
			padding: 2px 8px;
			border-radius: 4px;
			font-size: 11px;
			font-weight: 600;
			color: #fff;
		}
		.ta-truck-input { font-size: 12px; height: 28px; padding: 2px 8px; }
		.ta-empty { color: #6b7280; font-style: italic; padding: 20px; text-align: center; }

		/* Truck cards */
		.ta-trucks-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
			gap: 16px;
		}
		.ta-truck-card {
			border: 1px solid #e2e8f0;
			border-radius: 8px;
			padding: 14px;
			background: #fff;
		}
		.ta-truck-card.ta-truck-empty {
			border: 2px dashed #cbd5e1;
			background: #f8fafc;
		}
		.ta-truck-head {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 10px;
			padding-bottom: 10px;
			border-bottom: 1px solid #f1f5f9;
		}
		.ta-truck-num { font-size: 15px; font-weight: 700; color: #1e293b; }
		.ta-truck-btns { display: flex; gap: 4px; flex-wrap: wrap; }
		.ta-truck-driver { font-size: 12px; color: #6b7280; margin-bottom: 8px; }
		.ta-truck-warn {
			background: #fef3c7;
			border: 1px solid #f59e0b;
			border-radius: 4px;
			padding: 6px 10px;
			font-size: 11px;
			color: #92400e;
			margin-bottom: 8px;
		}
		.ta-truck-stats { display: flex; gap: 8px; margin-bottom: 8px; }
		.ta-truck-stat {
			flex: 1;
			background: #f8fafc;
			border-radius: 4px;
			padding: 6px;
			text-align: center;
			font-size: 10px;
			color: #6b7280;
			text-transform: uppercase;
		}
		.ta-truck-stat span { display: block; font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 2px; }
		.ta-cap-bar { background: #e2e8f0; border-radius: 4px; height: 6px; margin-bottom: 4px; overflow: hidden; }
		.ta-cap-fill { height: 100%; border-radius: 4px; }
		.ta-cap-label { font-size: 10px; color: #6b7280; margin-bottom: 8px; }
		.ta-truck-routes { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
		.ta-route-tag {
			background: #f1f5f9;
			color: #475569;
			border-radius: 3px;
			padding: 1px 6px;
			font-size: 11px;
		}
		.ta-truck-orders { max-height: 200px; overflow-y: auto; }
		.ta-truck-order {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 6px;
			margin-bottom: 4px;
			background: #f8fafc;
			border-radius: 4px;
			font-size: 12px;
		}
		.ta-order-link { font-weight: 600; color: #3b82f6; }
		.ta-order-cust { display: block; color: #6b7280; font-size: 11px; }
		.ta-order-loc  { display: block; color: #94a3b8; font-size: 10px; font-style: italic; }
		.ta-empty-truck { text-align: center; color: #94a3b8; padding: 16px; font-style: italic; }

		/* Closed trucks */
		.ta-closed-card { opacity: 0.85; }
		.ta-closed-card:hover { opacity: 1; }
		.ta-closed-toggle {
			padding: 8px 14px;
			font-size: 12px;
			font-weight: 600;
			color: #64748b;
			cursor: pointer;
			background: #f8fafc;
			user-select: none;
		}
		.ta-closed-toggle:hover { background: #f1f5f9; color: #475569; }
		.ta-closed-orders-list { border-top: 1px solid #f1f5f9; }

		/* Pagination */
		.ta-pg-bar {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 14px;
			padding: 12px 16px;
			border-top: 1px solid #e2e8f0;
			background: #f8fafc;
		}
		.ta-pg-info { font-size: 13px; color: #64748b; }
		.ta-pg-bar .btn { min-width: 70px; }
		</style>`;
	}
}
