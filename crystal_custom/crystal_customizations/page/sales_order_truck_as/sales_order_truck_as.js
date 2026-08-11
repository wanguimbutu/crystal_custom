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
		this.closed_trucks = [];
		this.trucks_tab = 'active';
		this._sps = new Set();
		this._regions = new Set();
		this.profitability_threshold = 33;
		this.setup_page();
		this.load_trucks_from_orders();
		this._fetch_fleet_settings();
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	setup_page() {
		// Nexus Spatial Engine Map Styles
		if (!$('#nexus-map-styles').length) {
			$('<style id="nexus-map-styles">').text(`
				.nexus-map-marker { background-color: #1e3a8a; color: white; border-radius: 50%; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.4); font-size: 13px; font-weight: bold; pointer-events: auto !important; }
				.nexus-factory-marker { background-color: #0f172a; color: #fbbf24; border-radius: 6px; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 4px 10px rgba(0,0,0,0.5); font-size: 18px; }
				.nexus-route-panel { position: fixed; top: 0; right: -60vw; width: 55vw; height: 100vh; background-color: #ffffff; box-shadow: -10px 0 30px rgba(0,0,0,0.2); z-index: 9999; transition: right 0.35s cubic-bezier(0.4, 0, 0.2, 1); display: flex; flex-direction: column; }
				.nexus-route-panel.active { right: 0; }
				.nexus-panel-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.6); z-index: 9998; display: none; backdrop-filter: blur(3px); }
				.nexus-panel-backdrop.active { display: block; }
				.nexus-panel-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 16px 20px; background-color: #1e293b; color: #ffffff; border-bottom: 1px solid #334155; }
				.nexus-panel-title { font-size: 18px; font-weight: 700; margin-top: 4px; color: #fff; }
				.btn-close-panel { background: transparent; border: none; color: #94a3b8; font-size: 28px; line-height: 1; padding: 0; cursor: pointer; transition: color 0.2s; }
				.btn-close-panel:hover { color: #ffffff; }
				.nexus-fuel-banner { display: flex; justify-content: space-between; padding: 15px 20px; background: #f8fafc; border-bottom: 2px solid #e2e8f0; }
				.nexus-eco-stat { display: flex; flex-direction: column; }
				.nexus-eco-stat span { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 700; }
				.nexus-eco-stat b { font-size: 18px; color: #0f172a; }

				/* 🚨 NEW: Margin Analysis panel — mirrors the route panel's slide
				   mechanic, but slides in from the LEFT (opposite side), matching
				   nexus_load_optimizer.js's existing .nexus-margin-panel pattern. */
				.nexus-margin-panel { position: fixed; top: 0; left: -60vw; width: 55vw; height: 100vh; background-color: #ffffff; box-shadow: 10px 0 30px rgba(0,0,0,0.2); z-index: 9999; transition: left 0.35s cubic-bezier(0.4, 0, 0.2, 1); display: flex; flex-direction: column; }
				.nexus-margin-panel.active { left: 0; }
				.nexus-margin-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.6); z-index: 9998; display: none; backdrop-filter: blur(3px); }
				.nexus-margin-backdrop.active { display: block; }
				.nexus-margin-panel-title { font-size: 18px; font-weight: 700; margin-top: 4px; color: #fff; }
				.btn-close-margin-panel { background: transparent; border: none; color: #94a3b8; font-size: 28px; line-height: 1; padding: 0; cursor: pointer; transition: color 0.2s; }
				.btn-close-margin-panel:hover { color: #ffffff; }
				.margin-stat-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #f1f5f9; }
				.margin-stat-label { font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; }
				.margin-stat-value { font-size: 15px; font-weight: 700; color: #0f172a; }
				.margin-headline { text-align: center; padding: 20px; border-radius: 10px; margin-top: 16px; }
				.margin-headline.profitable { background: #dcfce7; border: 2px solid #10b981; }
				.margin-headline.loss { background: #fee2e2; border: 2px solid #ef4444; }
				.margin-headline-value { font-size: 28px; font-weight: 900; }
				.margin-headline-pct { font-size: 16px; font-weight: 700; margin-top: 4px; }
				.margin-zero-cost-warning { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px; margin-top: 16px; font-size: 12px; color: #92400e; }
			`).appendTo('head');
		}

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
		this.page.add_button('Refresh', () => this.load_trucks_from_orders(), 'octicon octicon-sync');

		this.container = $('<div class="ta-container"></div>').appendTo(this.page.main);
		
		// Inject Leaflet Offcanvas Panel (Updated UI Layout)
		this.map_panel = $(`
			<div class="nexus-route-panel">
				<div class="nexus-panel-header">
				    <div>
				        <div style="font-size: 11px; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.5px;">Route Optimization</div>
					    <div class="nexus-panel-title">Active Route</div>
					</div>
					<button class="btn-close-panel" title="Close Panel">&times;</button>
				</div>
				<div class="nexus-fuel-banner" style="display:none;">
					<div class="nexus-eco-stat"><span>Distance</span><b id="nx-dist">0 km</b></div>
					<div class="nexus-eco-stat"><span>Est. Duration</span><b id="nx-dur">0 hrs</b></div>
					<div class="nexus-eco-stat"><span>Fuel Est. (KES)</span><b id="nx-fuel-cost" style="color:#ef4444">0</b></div>
				</div>
				<div id="nexus-unmapped-banner" style="display:none; background:#fffbeb; border-bottom:1px solid #fef3c7; padding:12px 20px; font-size:12px; color:#92400e;">
					<div style="font-weight:700; margin-bottom:4px;"><i class="fa fa-exclamation-triangle"></i> Unmapped Orders Excluded from Route:</div>
					<div id="nexus-unmapped-list" style="line-height:1.4;"></div>
				</div>
				<div id="nexus-leaflet-map" style="flex-grow: 1; background: #e2e8f0;"></div>
			</div>
			<div class="nexus-panel-backdrop"></div>
		`).appendTo(this.page.wrapper);

		this.map_panel.find('.btn-close-panel, .nexus-panel-backdrop').on('click', () => {
			this.page.wrapper.find('.nexus-route-panel, .nexus-panel-backdrop').removeClass('active');
		});

		// 🚨 NEW: Margin Analysis panel, created once at page load. Content
		// is populated on demand by render_margin_panel().
		this.margin_panel = $(`
			<div class="nexus-margin-panel">
				<div class="nexus-panel-header">
					<div>
						<div style="font-size: 11px; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.5px;">Margin Analysis</div>
						<div class="nexus-margin-panel-title">Margin Preview</div>
					</div>
					<button class="btn-close-margin-panel" title="Close Panel">&times;</button>
				</div>
				<div id="nexus-margin-content" style="flex-grow:1; overflow-y:auto; padding:20px;">
					<div class="text-center text-muted py-5">Select a truck or orders and click "Analyse Margins".</div>
				</div>
			</div>
			<div class="nexus-margin-backdrop"></div>
		`).appendTo(this.page.wrapper);

		this.margin_panel.find('.btn-close-margin-panel, .nexus-margin-backdrop').on('click', () => {
			this.close_margin_panel();
		});
	}

	_fetch_fleet_settings() {
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_fleet_settings',
			callback: (r) => {
				if (r.message && r.message.narrowed_margin_profitability_threshold !== undefined) {
					const parsed = parseFloat(r.message.narrowed_margin_profitability_threshold);
					if (!isNaN(parsed)) {
						this.profitability_threshold = parsed;
					}
				}
			}
		});
	}

	open_margin_panel() {
		this.page.wrapper.find('.nexus-margin-panel').addClass('active');
		this.page.wrapper.find('.nexus-margin-backdrop').addClass('active');
	}

	close_margin_panel() {
		this.page.wrapper.find('.nexus-margin-panel, .nexus-margin-backdrop').removeClass('active');
	}

	add_new_truck() {
		frappe.prompt([
			{ label: 'Truck Number', fieldname: 'truck_number', fieldtype: 'Data', reqd: 1 },
			{ label: 'Driver Name', fieldname: 'driver_name', fieldtype: 'Data' },
			{ label: 'Vehicle Type', fieldname: 'capacity_kg', fieldtype: 'Link', options: 'Vehicle Type', reqd: 1 },
		], (vals) => {
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.add_active_truck',
				args: {
					truck_number: vals.truck_number,
					driver_name: vals.driver_name || '',
					capacity_kg: vals.capacity_kg || 5000
				},
				callback: (r) => {
					if (!r.exc) {
						frappe.show_alert({ message: __('Truck {0} added', [vals.truck_number]), indicator: 'green' });
						this.load_trucks_from_orders();
					}
				}
			});
		}, __('Add Truck'), __('Add'));
	}

	// ── Data loading ──────────────────────────────────────────────────────────

	load_trucks_from_orders() {
		// Fetch Master Active Trucks
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_active_trucks',
			callback: (r) => {
				this.available_trucks = r.message || [];
				
				// Fetch Dispatched / History Trucks
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_dispatched_trucks',
					callback: (cr) => {
						this.closed_trucks = cr.message || [];
						this.load_data();
					},
					error: () => this.load_data()
				});
			},
			error: () => this.load_data()
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

				// Seed any newly-seen truck numbers automatically into the master DocType DB
				let missing = [];
				this.orders.forEach(o => {
					if (o.custom_truck_number && !this.available_trucks.find(t => t.truck_number === o.custom_truck_number)) {
						missing.push(o.custom_truck_number);
						this.available_trucks.push({
							truck_number: o.custom_truck_number,
							driver_name:  '',
							capacity_kg:  5000,
							trip_id:      '',
							warehouse_status: 'Pending' // Explicitly track state
						});
					}
				});
				
				// BULK CREATION FIX: Prevents Naming Series Deadlocks (Error 1020).
				if (missing.length) {
					frappe.call({
						method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.sync_missing_active_trucks',
						args: { truck_numbers_json: JSON.stringify([...new Set(missing)]) }
					});
				}

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
				(o.name                 || '').toLowerCase().includes(q) ||
				(o.customer_name        || '').toLowerCase().includes(q) ||
				(o.customer             || '').toLowerCase().includes(q) ||
				(o.sales_persons        || '').toLowerCase().includes(q) ||
				(o.custom_truck_number  || '').toLowerCase().includes(q)
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
		const sel_orders  = all_orders.filter(o => this.selected_orders.has(o.name));
		const sel_count   = sel_orders.length;
		const sel_weight  = sel_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
		const sel_value   = sel_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
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
			<span class="ta-bulk-stats-wrap">${sel_count ? `
				<span class="ta-bulk-stat-sep">·</span>
				<span class="ta-bulk-stat" title="Total weight of selected orders">&#9878; ${sel_weight.toFixed(1)} kg</span>
				<span class="ta-bulk-stat-sep">·</span>
				<span class="ta-bulk-stat" title="Total value of selected orders">${format_currency(sel_value, null, 0)}</span>
			` : ''}</span>
			<div class="ta-bulk-actions" style="align-items: center; gap: 8px;">
				<label class="ta-bulk-select-label" style="font-weight: normal; font-size: 12px;" title="Combine selected awaiting orders with orders already assigned to this truck">
					<input type="checkbox" class="ta-include-current-chk" disabled style="width:14px; height:14px; accent-color:#667eea; cursor:pointer;">
					Include Truck's Current Load
				</label>
				<button class="btn btn-sm btn-outline-dark btn-analyse-margins-awaiting" title="Analyse Margins for selected orders" ${!sel_count ? 'disabled' : ''}>
					Analyse Margins
				</button>
				<button class="btn btn-sm btn-black-action btn-optimize-awaiting" title="Optimize Route for selected orders" ${!sel_count ? 'disabled' : ''}>
					Optimize Route
				</button>
				<div style="width: 1px; height: 20px; background-color: #cbd5e1; margin: 0 4px;"></div>
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
						<div style="display:flex; justify-content:space-between; align-items:center;">
							<span>${frappe.utils.escape_html(o.customer_name || o.customer)}</span>
							${(o.custom_latitude && o.custom_longitude && parseFloat(o.custom_latitude) !== 0 && parseFloat(o.custom_longitude) !== 0) 
								? `<span class="ta-gps-badge ta-gps-mapped" title="GPS Available">&#10003; Mapped</span>`
								: `<span class="ta-gps-badge ta-gps-missing" title="No GPS Coordinates">No GPS</span>`}
						</div>
						${not_picked && o.custom_call_notes ? `<small class="ta-note">${frappe.utils.escape_html(o.custom_call_notes)}</small>` : ''}
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
			const capacity     = truck.max_tonnage || 0; // Use max_tonnage extracted by backend
			const cap_pct      = capacity > 0 ? Math.min((total_weight / capacity) * 100, 100).toFixed(0) : 0;
			const is_empty     = !truck_orders.length;
			const not_picked   = truck_orders.filter(o => o.custom_call_not_picked === 1).length;
			const regions      = [...new Set(truck_orders.map(o => o.custom_delivery_region).filter(Boolean))].sort();

			const is_loaded = truck.warehouse_status === 'Loaded';
			let loaded_badge = '';
			if (is_loaded) {
				loaded_badge = `<span style="font-size:10px; background:#10b981; color:#fff; padding:2px 7px; border-radius:12px; margin-left:8px; vertical-align:middle; text-transform:uppercase; letter-spacing:0.5px; font-weight:700; box-shadow: 0 0 5px rgba(16,185,129,0.4);">Ready for Dispatch</span>`;
			} else {
				loaded_badge = `<span style="font-size:10px; background:#f59e0b; color:#fff; padding:2px 7px; border-radius:12px; margin-left:8px; vertical-align:middle; text-transform:uppercase; letter-spacing:0.5px; font-weight:700;">Pending Loading</span>`;
			}

			html += `
			<div class="ta-truck-card${is_empty ? ' ta-truck-empty' : ''}" style="${is_loaded ? 'border: 2px solid #10b981;' : 'border: 1px solid #fcd34d;'}">
				
				<!-- HEADER SECTION -->
				<div class="ta-card-header">
					<div class="ta-truck-head">
						<div>
							<div class="ta-truck-num">${frappe.utils.escape_html(truck.truck_number)}${loaded_badge}</div>
							${truck.trip_id ? `<div style="font-size:10px;color:#94a3b8;letter-spacing:.5px;">${frappe.utils.escape_html(truck.trip_id)}</div>` : ''}
						</div>
					</div>

					${truck.driver_name ? `<div class="ta-truck-driver"><i class="fa fa-user" style="color:#94a3b8; margin-right:4px;"></i>${frappe.utils.escape_html(truck.driver_name)}</div>` : ''}
					
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
					${regions.length ? `<div class="ta-truck-routes">${regions.map(r => `<span class="ta-route-tag"><i class="fa fa-map-marker"></i> ${r}</span>`).join('')}</div>` : ''}
					` : '<div class="ta-empty-truck">Waiting for assignments...</div>'}

					<!-- NEATLY ARRANGED ACTION BUTTONS — TWO ROWS -->
					<div class="ta-truck-btns-container">
						${!is_empty ? `
						<div class="ta-truck-actions-primary">
							<button class="btn btn-sm btn-outline-dark btn-analyse-margins-truck" data-truck="${truck.truck_number}">Analyse Margins</button>
							<button class="btn btn-sm btn-black-action btn-optimize-truck" data-truck="${truck.truck_number}">Optimize Route</button>
							<button class="btn btn-sm btn-primary btn-close-truck" data-truck="${truck.truck_number}">Dispatch</button>
						</div>` : ''}
						<div class="ta-truck-actions-icons">
							<button class="btn btn-xs btn-default btn-dl-manifest" data-truck="${truck.truck_number}" title="Download manifest"><i class="fa fa-download"></i></button>
							<button class="btn btn-xs btn-default btn-edit-truck" data-truck="${truck.truck_number}" title="Edit"><i class="fa fa-pencil"></i></button>
							${!is_empty ? `<button class="btn btn-xs btn-default btn-reassign-truck" data-truck="${truck.truck_number}" title="Move all orders to another truck"><i class="fa fa-exchange"></i></button>` : ''}
							<button class="btn btn-xs btn-danger btn-delete-truck" data-truck="${truck.truck_number}" title="${is_empty ? 'Remove truck' : 'Unassign all orders'}"><i class="fa fa-trash"></i></button>
						</div>
					</div>
				</div>

				<!-- SALES ORDERS SECTION -->
				<div class="ta-card-orders-section">
					<div class="ta-orders-header">Assigned Orders</div>
					${not_picked ? `<div class="ta-truck-warn">${not_picked} customer(s) did not answer — driver should contact on arrival</div>` : ''}

					${!is_empty ? `
					<div class="ta-truck-orders">
						${truck_orders.map(o => `
						<div class="ta-truck-order">
							<div style="width:100%;">
								<div style="display:flex; justify-content:space-between;">
									<a href="/app/sales-order/${o.name}" target="_blank" class="ta-order-link">${o.name}</a>
									${(o.custom_latitude && o.custom_longitude && parseFloat(o.custom_latitude) !== 0 && parseFloat(o.custom_longitude) !== 0) 
										? `<span style="color:#10b981; font-size:10px; font-weight:600;">&#10003; Mapped</span>`
										: `<span style="color:#94a3b8; font-size:10px;">No GPS</span>`}
								</div>
								<span class="ta-order-cust">${frappe.utils.escape_html(o.customer_name || o.customer)}</span>
								${o.custom_location ? `<span class="ta-order-loc"><i class="fa fa-map-pin" style="color:#94a3b8;"></i> ${frappe.utils.escape_html(o.custom_location)}</span>` : ''}
							</div>
							<button class="btn btn-xs btn-default btn-unassign" data-order="${o.name}" title="Remove from truck">&#215;</button>
						</div>`).join('')}
					</div>
					` : ''}
				</div>

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
				<div class="ta-card-header" style="background:#f1f5f9;">
					<div class="ta-truck-head">
						<div>
							<div class="ta-truck-num" style="color:#334155;">&#10003; ${frappe.utils.escape_html(ct.truck_number)}</div>
							${ct.trip_id ? `<div style="font-size:10px;color:#94a3b8;letter-spacing:.5px;">${frappe.utils.escape_html(ct.trip_id)}</div>` : ''}
						</div>
						<div style="text-align:right;">
							<div style="font-size:11px;color:#64748b;font-weight:600;">${frappe.utils.escape_html(closed_label)}</div>
						</div>
					</div>
					${ct.driver_name ? `<div class="ta-truck-driver"><i class="fa fa-user" style="color:#94a3b8; margin-right:4px;"></i>${frappe.utils.escape_html(ct.driver_name)}</div>` : ''}
					
					<div class="ta-truck-stats">
						<div class="ta-truck-stat"><span>${ct.order_count}</span>Orders</div>
						<div class="ta-truck-stat"><span>${(ct.total_weight || 0).toFixed(0)} kg</span>Weight</div>
						<div class="ta-truck-stat"><span>${format_currency(ct.total_value || 0, null, 0)}</span>Value</div>
					</div>
				</div>

				<div class="ta-card-orders-section">
					<div class="ta-orders-section">
						<div class="ta-closed-toggle" data-idx="${idx}">
							&#9658; View ${(ct.orders || []).length} order${(ct.orders || []).length !== 1 ? 's' : ''}
						</div>
						<div class="ta-closed-orders-list" id="ta-closed-orders-${idx}" style="display:none;">
							${order_rows}
						</div>
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
			const unassigned   = self.get_filtered_orders().filter(o => !o.custom_truck_number);
			const sel_orders   = unassigned.filter(o => self.selected_orders.has(o.name));
			const sel_count    = sel_orders.length;
			const all_checked  = sel_count === unassigned.length && unassigned.length > 0;
			const sel_weight_u = sel_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
			const sel_value_u  = sel_orders.reduce((s, o) => s + (o.grand_total || 0), 0);

			self.container.find('.ta-select-all-chk').prop('checked', all_checked);
			self.container.find('.ta-bulk-count').text(`${sel_count} of ${unassigned.length} selected`);
			self.container.find('.ta-bulk-stats-wrap').html(sel_count ? `
				<span class="ta-bulk-stat-sep">·</span>
				<span class="ta-bulk-stat" title="Total weight of selected orders">&#9878; ${sel_weight_u.toFixed(1)} kg</span>
				<span class="ta-bulk-stat-sep">·</span>
				<span class="ta-bulk-stat" title="Total value of selected orders">${format_currency(sel_value_u, null, 0)}</span>
			` : '');
			self.container.find('.ta-bulk-assign-btn').prop('disabled', sel_count === 0);
			self.container.find('.ta-bulk-truck-input').prop('disabled', sel_count === 0);
			self.container.find('.btn-optimize-awaiting').prop('disabled', sel_count === 0);
			self.container.find('.btn-analyse-margins-awaiting').prop('disabled', sel_count === 0);

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

		// ── Dynamic UI Validation: Toggle Checkbox based on Truck Input ─────────────────────
		this.container.find('.ta-bulk-truck-input').off('input.chk-toggle').on('input.chk-toggle', function() {
			const hasVal = $(this).val().trim().length > 0;
			const $chk = self.container.find('.ta-include-current-chk');
			$chk.prop('disabled', !hasVal);
			
			if (!hasVal) {
				const wasChecked = $chk.prop('checked');
				$chk.prop('checked', false);
				// Automatically re-optimize if the map is open and the box was forced unchecked
				if (wasChecked && self.page.wrapper.find('.nexus-route-panel').hasClass('active')) {
					self.container.find('.btn-optimize-awaiting').trigger('click');
				}
			}
		});

		// ── Dynamic Re-optimization on Checkbox Toggle ──────────────────────────────
		this.container.find('.ta-include-current-chk').off('change.chk-reopt').on('change.chk-reopt', function() {
			// Only trigger API computation if the spatial map panel is currently active
			if (self.page.wrapper.find('.nexus-route-panel').hasClass('active')) {
				self.container.find('.btn-optimize-awaiting').trigger('click');
			}
		});

		// ── Route Optimization Buttons ──────────────────────────────────────────────

		this.container.find('.btn-optimize-awaiting').off('click').on('click', () => {
			const unassigned = this.get_filtered_orders().filter(o => !o.custom_truck_number);
			let selected_orders_data = unassigned.filter(o => this.selected_orders.has(o.name));

			// Capture the currently typed truck number from the bulk assignment input
			const truck_input_val = this.container.find('.ta-bulk-truck-input').val().trim();
			const include_current = this.container.find('.ta-include-current-chk').is(':checked');

			// If checkbox is checked and a truck is specified, concatenate current manifest orders
			if (include_current && truck_input_val) {
				const current_truck_orders = this.orders.filter(o => o.custom_truck_number === truck_input_val);
				
				// Merge arrays while preventing duplicate order entries if an assigned order was somehow also selected
				const selectedNames = new Set(selected_orders_data.map(o => o.name));
				const uniqueExisting = current_truck_orders.filter(o => !selectedNames.has(o.name));
				
				selected_orders_data = [...selected_orders_data, ...uniqueExisting];
			}
			
			// Search loaded available trucks for the matching parameters
			const truck_info = this.available_trucks.find(t => t.truck_number === truck_input_val);
			
			// Extract vehicle type (stored in capacity_kg based on your DocType link)
			const vehicle_type = truck_info ? truck_info.capacity_kg : null;
			const truck_number = truck_input_val || null;

			// Pass the extracted variables to the spatial engine
			this.open_route_optimizer('Pre-Analysis: Awaiting Orders', selected_orders_data, vehicle_type, truck_number);
		});

		this.container.find('.btn-optimize-truck').off('click').on('click', (e) => {
			const tn = $(e.currentTarget).data('truck');
			const truck_orders = this.orders.filter(o => o.custom_truck_number === tn);
			const truck_info = this.available_trucks.find(t => t.truck_number === tn);
			this.open_route_optimizer(`Active Route: ${tn}`, truck_orders, truck_info ? truck_info.capacity_kg : null, tn);
		});

		// 🚨 NEW: Analyse Margins — reuses the exact same selection/merge
		// logic as .btn-optimize-awaiting above, just routed to the margin
		// analyzer instead of the route panel.
		this.container.find('.btn-analyse-margins-awaiting').off('click').on('click', () => {
			const unassigned = this.get_filtered_orders().filter(o => !o.custom_truck_number);
			let selected_orders_data = unassigned.filter(o => this.selected_orders.has(o.name));

			const truck_input_val = this.container.find('.ta-bulk-truck-input').val().trim();
			const include_current = this.container.find('.ta-include-current-chk').is(':checked');

			if (include_current && truck_input_val) {
				const current_truck_orders = this.orders.filter(o => o.custom_truck_number === truck_input_val);
				const selectedNames = new Set(selected_orders_data.map(o => o.name));
				const uniqueExisting = current_truck_orders.filter(o => !selectedNames.has(o.name));
				selected_orders_data = [...selected_orders_data, ...uniqueExisting];
			}

			const truck_info = this.available_trucks.find(t => t.truck_number === truck_input_val);
			const vehicle_type = truck_info ? truck_info.capacity_kg : null;
			const truck_number = truck_input_val || null;

			this.open_margin_analyzer('Margin Analysis: Awaiting Orders', selected_orders_data, vehicle_type, truck_number);
		});

		this.container.find('.btn-analyse-margins-truck').off('click').on('click', (e) => {
			const tn = $(e.currentTarget).data('truck');
			const truck_orders = this.orders.filter(o => o.custom_truck_number === tn);
			const truck_info = this.available_trucks.find(t => t.truck_number === tn);
			this.open_margin_analyzer(`Margin Analysis: ${tn}`, truck_orders, truck_info ? truck_info.capacity_kg : null, tn);
		});

		// ── Per-row truck assignment ───────────────────────────────────────────────

		// Truck assignment via text input (on change / blur)
		this.container.find('.ta-truck-input').off('change').on('change', function () {
			const order_name   = $(this).data('order');
			const truck_number = $(this).val().trim();
			if (truck_number && !self.available_trucks.find(t => t.truck_number === truck_number)) {
				// Call backend to ensure DocType is created immediately
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.add_active_truck',
					args: { truck_number },
					callback: () => self._set_truck(order_name, truck_number)
				});
			} else {
				self._set_truck(order_name, truck_number);
			}
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

		const proceed_assignment = () => {
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
						this.load_trucks_from_orders();
					});
				}
			);
		};

		if (!this.available_trucks.find(t => t.truck_number === truck_number)) {
			// Fast UI update, then ensure backend catches up before assigning
			this.available_trucks.push({ truck_number, driver_name: '', capacity_kg: 5000, trip_id: '' });
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.add_active_truck',
				args: { truck_number },
				callback: proceed_assignment
			});
		} else {
			proceed_assignment();
		}
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
				this.load_trucks_from_orders();
			},
		});
	}

	_set_truck_batch(orders, truck_number, on_done) {
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.set_truck_batch_atomic',
			args: { 
				truck_number: truck_number,
				order_names_json: JSON.stringify(orders.map(o => o.name || o)) 
			},
			callback: () => {
				if (on_done) on_done();
				else {
					frappe.show_alert({ message: __('Done — {0} orders updated', [orders.length]), indicator: 'green' });
					this.load_trucks_from_orders();
				}
			}
		});
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	edit_truck_details(truck_number) {
		const truck = this.available_trucks.find(t => t.truck_number === truck_number);
		frappe.prompt([
			{ label: 'Truck Number', fieldname: 'truck_number', fieldtype: 'Data',  default: truck.truck_number, reqd: 1, read_only: 1 },
			{ label: 'Driver Name',  fieldname: 'driver_name',  fieldtype: 'Data',  default: truck.driver_name },
			{ label: 'Vehicle Type', fieldname: 'capacity_kg', fieldtype: 'Link', options: 'Vehicle Type', default: truck.capacity_kg, reqd: 1 },
		], (vals) => {
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.update_active_truck',
				args: {
					truck_number: vals.truck_number,
					driver_name: vals.driver_name,
					capacity_kg: vals.capacity_kg
				},
				callback: () => {
					frappe.show_alert({ message: __('Truck updated'), indicator: 'green' });
					this.load_trucks_from_orders();
				}
			});
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
		
		const finalize_delete = () => {
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.delete_active_truck',
				args: { truck_number },
				callback: () => {
					frappe.show_alert({ message: __('Truck removed'), indicator: 'green' });
					this.load_trucks_from_orders();
				}
			});
		};

		if (!truck_orders.length) {
			finalize_delete();
		} else {
			frappe.confirm(
				__('Unassign {0} orders from {1}? They will return to the unassigned list.', [truck_orders.length, truck_number]),
				() => {
					// Empty assignment batch call unlinks them first
					this._set_truck_batch(truck_orders, '', finalize_delete);
				}
			);
		}
	}

	close_truck(truck_number) {
		const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
		if (!truck_orders.length) { frappe.msgprint(__('Cannot close an empty truck')); return; }

		const truck = this.available_trucks.find(t => t.truck_number === truck_number);
		const is_pending = truck && truck.warehouse_status !== 'Loaded';
		const unsubmitted = truck_orders.filter(o => parseInt(o.docstatus) === 0);

		let msg = '';
		if (is_pending) {
			msg = __('The warehouse is still <strong>Pending Loading</strong>. Dispatch anyway?<br><br><span style="font-size:12px;color:#64748b;">(Trip will be recorded and truck cleared for the next load).</span>');
		} else if (unsubmitted.length) {
			msg = __('Truck {0} has {1} unsubmitted order(s). Dispatch anyway? Trip will be recorded and truck cleared for the next load.', [truck_number, unsubmitted.length]);
		} else {
			msg = __('Dispatch truck {0} with {1} orders? Trip will be recorded and truck cleared for the next load.', [truck_number, truck_orders.length]);
		}

		frappe.confirm(msg, () => {
			this.download_manifest(truck_number);
			
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.dispatch_truck',
				args: { truck_number: truck_number },
				callback: () => {
					frappe.show_alert({ message: __('Trip recorded for {0}', [truck_number]), indicator: 'green' });
					this.load_trucks_from_orders();
				},
				error: () => frappe.msgprint(__('Failed to dispatch truck {0}. Please try again.', [truck_number]))
			});
		});
	}

	reopen_truck(idx) {
		const ct = this.closed_trucks[idx];
		if (!ct) return;

		frappe.confirm(
			__('Reopen truck {0}? Orders will be restored to active.', [ct.truck_number]),
			() => {
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.reopen_dispatched_truck',
					args: { truck_number: ct.truck_number },
					callback: () => {
						frappe.show_alert({ message: __('Truck {0} reopened', [ct.truck_number]), indicator: 'green' });
						this.load_trucks_from_orders();
					},
					error: () => frappe.msgprint(__('Could not reopen truck {0}', [ct.truck_number]))
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
			// Closed trucks are Submitted DocTypes, so we use Frappe's set_value to alter metadata
			frappe.call({
				method: 'frappe.client.set_value',
				args: {
					doctype: 'Crystal Truck Plan',
					name: ct.trip_id,
					fieldname: {
						driver_name: vals.driver_name,
						capacity_kg: vals.capacity_kg
					}
				},
				callback: () => {
					frappe.show_alert({ message: __('Truck {0} updated', [ct.truck_number]), indicator: 'green' });
					this.load_trucks_from_orders();
				}
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

// ── Spatial / Routing Logic (Leaflet + Nexus Backend) ─────────────────────

	open_route_optimizer(title, orders, vehicle_type, truck_number = null) {
		// 1. Reveal Panel and Reset State
		this.page.wrapper.find('.nexus-route-panel').addClass('active');
		this.page.wrapper.find('.nexus-panel-backdrop').addClass('active');
		this.page.wrapper.find('.nexus-panel-title').text(title);
		
		$('#nx-dist').html('<i class="fa fa-spinner fa-spin"></i>');
		$('#nx-dur').html('<i class="fa fa-spinner fa-spin"></i>');
		$('#nx-fuel-cost').html('<i class="fa fa-spinner fa-spin"></i>');
		$('.nexus-fuel-banner').show();

		// 2. Load Leaflet and Execute Pipeline
		frappe.require([
			"/assets/nexus_supply_chain/leaflet/leaflet.css",
			"/assets/nexus_supply_chain/leaflet/leaflet.js"
		], () => {
			this._execute_route_mapping(orders, vehicle_type, 'nexus-leaflet-map', truck_number);
		});
	}

	_execute_route_mapping(orders, vehicle_type, container_id, truck_number = null) {
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_company_coordinates',
			callback: (r) => {
				if (!r.message || r.message.status === 'error') {
					frappe.msgprint("Factory coordinates not set in Global Defaults. Cannot map route.");
					return;
				}
				
				// FIX: Force factory coordinates into strict floats
				const factory_lat = parseFloat(r.message.lat);
				const factory_lng = parseFloat(r.message.lng);

				// FIX: Harden filter to rigorously check for and exclude 0 values
				const valid_stops = orders.filter(o => 
					o.custom_latitude && 
					o.custom_longitude && 
					parseFloat(o.custom_latitude) !== 0 && 
					parseFloat(o.custom_longitude) !== 0
				);
				
				const unmapped_stops = orders.filter(o => 
					!o.custom_latitude || 
					!o.custom_longitude || 
					parseFloat(o.custom_latitude) === 0 || 
					parseFloat(o.custom_longitude) === 0
				);
				
				// Display the Unmapped Banner if there are any skipped orders
				if (unmapped_stops.length > 0) {
					const unmapped_html = unmapped_stops.map(o => `<b>${o.name}</b> (${frappe.utils.escape_html(o.customer_name)})`).join(', ');
					$('#nexus-unmapped-list').html(unmapped_html);
					$('#nexus-unmapped-banner').slideDown(200);
				} else {
					$('#nexus-unmapped-banner').hide();
				}

				// Handle edge case where NO orders have GPS coordinates
				if (valid_stops.length === 0) {
					frappe.msgprint("None of the mapped orders have valid GPS coordinates. Showing unmapped load.");
					$('#nx-dist').text('0 km');
					$('#nx-dur').text('0 hrs');
					$('#nx-fuel-cost').text('N/A');
					// Render the map centered on the factory with just the banner
					this._render_leaflet_map({features: []}, factory_lat, factory_lng, [], container_id);
					return;
				}

				// Build Sequence [lng, lat]
				let coordinates = [[factory_lng, factory_lat]];
				valid_stops.forEach(o => {
					coordinates.push([parseFloat(o.custom_longitude), parseFloat(o.custom_latitude)]);
				});
				coordinates.push([factory_lng, factory_lat]);

				// 🚨 UPDATED: Routed through Frappe's calculate_route_proxy instead
				// of calling Crystal API directly from the browser — a secret
				// embedded in client-side JS is visible in dev tools and can never
				// safely gate this call, so the proxy attaches it server-side.
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.calculate_route_proxy',
					args: { coordinates_json: JSON.stringify(coordinates) },
					callback: (route_r) => {
						const data = route_r.message;
						if (!data || data.error) {
							frappe.msgprint("Map Engine Error: " + (data ? data.error : "Unknown error"));
							return;
						}

						let ordered_stops = valid_stops;
						if (Array.isArray(data.waypoint_order) && data.waypoint_order.length === valid_stops.length) {
							ordered_stops = data.waypoint_order.map(idx => valid_stops[idx]).filter(Boolean);
						}

						// Draw Map — numbered per the real route sequence
						this._render_leaflet_map(data, factory_lat, factory_lng, ordered_stops, container_id);

						// Extract Economics
						const distance_km = data.features[0].properties.summary.distance / 1000;
						const duration_hrs = data.features[0].properties.summary.duration / 3600;

						$('#nx-dist').text(distance_km.toFixed(1) + ' km');
						$('#nx-dur').text(duration_hrs.toFixed(1) + ' hrs');

						if (truck_number) {
							const sequence = ordered_stops.map(o => o.name);
							frappe.call({
								method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.reorder_truck_plan_orders',
								args: { truck_number: truck_number, sales_order_sequence_json: JSON.stringify(sequence) }
							});
						}

						// Now calls get_vehicle_routing_economics
						if (vehicle_type || truck_number) {
							frappe.call({
								method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_vehicle_routing_economics',
								args: { distance_km: distance_km, vehicle_type: vehicle_type, truck_number: truck_number },
								callback: (cost_r) => {
									if (cost_r.message && cost_r.message.status === 'success') {
										const estCost = parseFloat(cost_r.message.estimated_fuel_cost) || 0.0;
										$('#nx-fuel-cost').text(`${cost_r.message.currency} ${estCost.toLocaleString(undefined, {minimumFractionDigits: 2})}`);
									} else {
										const errMsg = cost_r.message && cost_r.message.message ? cost_r.message.message : 'Unknown Backend Error';
										console.warn("Vehicle Routing Economics:", errMsg);
										$('#nx-fuel-cost').text('Math Err');
									}
								}
							});
						} else {
							$('#nx-fuel-cost').text('Select Truck to Estimate');
						}
					},
					error: () => {
						frappe.msgprint("Failed to communicate with the routing engine orchestrator.");
					}
				});
			}
		});
	}

	_render_leaflet_map(geojson_data, factory_lat, factory_lng, valid_stops, container_id) {
		if (!this.route_map) {
			this.route_map = L.map(container_id, { zoomControl: false }).setView([factory_lat, factory_lng], 12);
			L.control.zoom({ position: 'topright' }).addTo(this.route_map);
			L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: 'Nexus Spatial Engine' }).addTo(this.route_map);
			this.map_layers = [];
		}

		this.map_layers.forEach(layer => this.route_map.removeLayer(layer));
		this.map_layers = [];

		const routeLayer = L.geoJSON(geojson_data, { 
			style: { color: '#3b82f6', weight: 6, opacity: 0.85, dashArray: '10, 6' } 
		}).addTo(this.route_map);
		this.map_layers.push(routeLayer);

		const factoryIcon = L.divIcon({ 
			className: '', html: `<div class="nexus-factory-marker"><i class="fa fa-industry" style="color:white;"></i></div>`, iconSize: [36, 36], iconAnchor: [18, 18] 
		});
		const f_marker = L.marker([factory_lat, factory_lng], { icon: factoryIcon, zIndexOffset: 1000 })
			.addTo(this.route_map).bindPopup("Factory Dispatch");
		this.map_layers.push(f_marker);

		// Drop sequence markers using exact VROOM logic 
		valid_stops.forEach((so, i) => {
			const icon = L.divIcon({ 
				className: '', html: `<div class="nexus-map-marker">${i+1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] 
			});
			const m = L.marker([so.custom_latitude, so.custom_longitude], { icon: icon }).addTo(this.route_map)
				.bindPopup(`<b>Stop ${i+1}: ${so.customer_name}</b><br>Order Value: ${format_currency(so.grand_total)}<br>Tonnage: ${(so.total_net_weight || 0).toFixed(1)} kg`);
			this.map_layers.push(m);
		});

		// Prevent Leaflet crash if the bounds are entirely empty
		if (valid_stops.length > 0) {
			this.route_map.fitBounds(routeLayer.getBounds(), { padding: [60, 60] });
		} else {
			this.route_map.setView([factory_lat, factory_lng], 12);
		}
		
		// Invalidate size to fix off-canvas rendering glitches
		setTimeout(() => { this.route_map.invalidateSize(); }, 350);
	}

	// ── Margin Analysis Logic (mirrors the routing logic above, opposite panel) ─

	open_margin_analyzer(title, orders, vehicle_type, truck_number = null) {
		this.page.wrapper.find('.nexus-margin-panel-title').text(title);
		this.open_margin_panel();
		$('#nexus-margin-content').html(`
			<div class="text-center py-5">
				<i class="fa fa-spinner fa-spin fa-2x text-primary"></i>
				<p class="text-muted mt-3">Computing margin analysis...</p>
			</div>
		`);
		this._execute_margin_analysis(orders, vehicle_type, truck_number);
	}

	_execute_margin_analysis(orders, vehicle_type, truck_number) {
		if (!orders.length) {
			$('#nexus-margin-content').html(`<div class="alert alert-warning mt-2">No orders selected for margin analysis.</div>`);
			return;
		}

		// Same valid_stops/unmapped_stops filter used by _execute_route_mapping —
		// orders with null/zero coordinates are excluded from the distance
		// computation entirely, never coerced to (0,0).
		const valid_stops = orders.filter(o =>
			o.custom_latitude &&
			o.custom_longitude &&
			parseFloat(o.custom_latitude) !== 0 &&
			parseFloat(o.custom_longitude) !== 0
		);
		const unmapped_stops = orders.filter(o =>
			!o.custom_latitude ||
			!o.custom_longitude ||
			parseFloat(o.custom_latitude) === 0 ||
			parseFloat(o.custom_longitude) === 0
		);

		const sales_order_names = orders.map(o => o.name);

		const run_analysis = (distance_km) => {
			frappe.call({
				method: 'nexus_supply_chain.routing.margin_analysis.get_margin_analysis',
				args: {
					sales_orders: JSON.stringify(sales_order_names),
					distance_km: distance_km,
					vehicle_type: vehicle_type,
					truck_number: truck_number
				},
				callback: (r) => {
					this.render_margin_panel(orders.length, r.message, unmapped_stops.length);
				},
				error: () => {
					$('#nexus-margin-content').html(`<div class="alert alert-danger mt-2">Server error computing margin analysis.</div>`);
				}
			});
		};

		if (valid_stops.length === 0) {
			// No GPS on any order — skip the route call entirely; distance
			// stays null and get_margin_analysis reports it as unavailable
			// rather than fabricating a 0 km figure.
			run_analysis(null);
			return;
		}

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_company_coordinates',
			callback: (r) => {
				if (!r.message || r.message.status === 'error') {
					run_analysis(null);
					return;
				}

				const factory_lat = parseFloat(r.message.lat);
				const factory_lng = parseFloat(r.message.lng);

				let coordinates = [[factory_lng, factory_lat]];
				valid_stops.forEach(o => {
					coordinates.push([parseFloat(o.custom_longitude), parseFloat(o.custom_latitude)]);
				});
				coordinates.push([factory_lng, factory_lat]);

				// 🚨 UPDATED: Routed through Frappe's calculate_route_proxy — see
				// the matching note in _execute_route_mapping above.
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.calculate_route_proxy',
					args: { coordinates_json: JSON.stringify(coordinates) },
					callback: (route_r) => {
						const data = route_r.message;
						if (!data || data.error) {
							run_analysis(null);
							return;
						}
						const distance_km = data.features[0].properties.summary.distance / 1000;
						run_analysis(distance_km);
					},
					error: () => {
						run_analysis(null);
					}
				});
			}
		});
	}

	render_margin_panel(order_count, data, unmapped_count) {
		if (!data || data.status !== 'success') {
			$('#nexus-margin-content').html(`
				<div class="alert alert-danger mt-2">
					<i class="fa fa-exclamation-triangle me-2"></i>
					Failed to compute margin analysis.
				</div>
			`);
			return;
		}

		const currency = data.currency || 'KES';
		const fmt = (val) => `${currency} ${parseFloat(val || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

		const is_profitable = data.narrowed_gross_margin_percentage >= this.profitability_threshold;
		const headline_class = is_profitable ? 'profitable' : 'loss';
		const headline_color = is_profitable ? '#166534' : '#991b1b';

		let fuel_html = '';
		if (data.distance_available && data.fuel_available) {
			fuel_html = `
				<div class="margin-stat-row">
					<span class="margin-stat-label">Route Distance (Roundtrip)</span>
					<span class="margin-stat-value">${data.distance_km.toFixed(1)} km</span>
				</div>
				<div class="margin-stat-row">
					<span class="margin-stat-label">Estimated Fuel Cost</span>
					<span class="margin-stat-value" style="color:#ef4444;">${fmt(data.approximate_fuel_cost)}</span>
				</div>
			`;
		} else if (data.distance_available && !data.fuel_available) {
			fuel_html = `
				<div class="alert alert-warning mt-2" style="font-size:12px;">
					Fuel estimate unavailable — assign a Vehicle Type to this truck to estimate fuel cost.
				</div>
			`;
		} else {
			fuel_html = `
				<div class="alert alert-secondary mt-2" style="font-size:12px;">
					Distance unavailable — no GPS data on any selected order.
				</div>
			`;
		}

		let unmapped_html = '';
		if (unmapped_count > 0) {
			unmapped_html = `
				<div class="alert alert-warning mt-2" style="font-size:12px;">
					<i class="fa fa-exclamation-triangle me-1"></i>
					${unmapped_count} order(s) excluded from the distance/fuel estimate — no GPS coordinates.
				</div>
			`;
		}

		let zero_cost_html = '';
		if (data.zero_cost_items && data.zero_cost_items.length > 0) {
			zero_cost_html = `
				<div class="margin-zero-cost-warning">
					<b><i class="fa fa-exclamation-triangle me-1"></i> Margin Accuracy Warning</b><br>
					The following item(s) have no Default BOM — their cost was treated as 0, which inflates the margin above:
					<div class="mt-1"><b>${data.zero_cost_items.join(', ')}</b></div>
				</div>
			`;
		}

		const html = `
			<div class="mb-3 text-muted" style="font-size:12px;">${order_count} order(s) analysed</div>

			<div class="margin-stat-row">
				<span class="margin-stat-label">Total Order Value (Incl. VAT)</span>
				<span class="margin-stat-value">${fmt(data.total_order_value)}</span>
			</div>
			<div class="margin-stat-row">
				<span class="margin-stat-label">VAT (${data.vat_rate_percentage.toFixed(0)}%)</span>
				<span class="margin-stat-value text-muted">- ${fmt(data.vat_amount)}</span>
			</div>
			<div class="margin-stat-row">
				<span class="margin-stat-label">Revenue (Excl. VAT)</span>
				<span class="margin-stat-value">${fmt(data.revenue_excl_vat)}</span>
			</div>
			<div class="margin-stat-row">
				<span class="margin-stat-label">Total Theoretical Cost (COGS)</span>
				<span class="margin-stat-value text-muted">- ${fmt(data.total_theoretical_cost)}</span>
			</div>
			<div class="margin-stat-row">
				<span class="margin-stat-label">Gross Profit</span>
				<span class="margin-stat-value">${fmt(data.gross_profit)}</span>
			</div>
			<div class="margin-stat-row" style="border-bottom:none;">
				<span class="margin-stat-label">Gross Margin %</span>
				<span class="margin-stat-value">${data.gross_margin_percentage.toFixed(2)}%</span>
			</div>

			${fuel_html}
			${unmapped_html}

			<div class="margin-headline ${headline_class}">
				<div class="margin-stat-label" style="color:${headline_color};">Narrowed Gross Margin</div>
				<div class="margin-headline-value" style="color:${headline_color};">${fmt(data.narrowed_gross_profit)}</div>
				<div class="margin-headline-pct" style="color:${headline_color};">${data.narrowed_gross_margin_percentage.toFixed(2)}% — ${is_profitable ? 'Profitable' : 'Loss'}</div>
			</div>

			${zero_cost_html}
		`;

		$('#nexus-margin-content').html(html);
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

		/* Custom Black Action Button for Optimize Route */
		.btn-black-action {
			background-color: #111827 !important;
			color: #ffffff !important;
			font-weight: 600 !important;
			letter-spacing: normal !important;
			border: 1px solid #111827 !important;
		}
		.btn-black-action:hover {
			background-color: #000000 !important;
			color: #ffffff !important;
		}
		.btn-black-action:disabled {
			background-color: #6b7280 !important;
			border-color: #6b7280 !important;
			opacity: 0.7;
			cursor: not-allowed;
		}

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
		.ta-bulk-stat { font-size: 13px; color: #1e293b; white-space: nowrap; }
		.ta-bulk-stat-sep { color: #cbd5e1; font-size: 16px; line-height: 1; padding: 0 2px; }
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

		/* Truck cards - 3 COLUMNS */
		.ta-trucks-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 16px;
		}
		@media (max-width: 1200px) {
			.ta-trucks-grid {
				grid-template-columns: repeat(2, minmax(0, 1fr));
			}
		}
		@media (max-width: 768px) {
			.ta-trucks-grid {
				grid-template-columns: minmax(0, 1fr);
			}
		}

		/* Segmented Card Design */
		.ta-truck-card {
			border: 1px solid #e2e8f0;
			border-radius: 8px;
			background: #fff;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.ta-truck-card.ta-truck-empty {
			border: 2px dashed #cbd5e1;
		}
		
		.ta-card-header {
			padding: 14px;
			background: #f8fafc;
			border-bottom: 2px solid #e2e8f0;
		}
		.ta-card-orders-section {
			padding: 14px;
			flex-grow: 1;
			background: #ffffff;
		}
		.ta-orders-header {
			font-size: 11px;
			font-weight: 700;
			color: #64748b;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			margin-bottom: 10px;
			padding-bottom: 6px;
			border-bottom: 1px solid #f1f5f9;
		}
		
		.ta-truck-head {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 6px;
		}
		.ta-truck-num { font-size: 15px; font-weight: 700; color: #1e293b; }
		
		/* Spaced Action Buttons — two rows: primary actions, then icon utilities */
		.ta-truck-btns-container { 
			display: flex; 
			flex-direction: column;
			gap: 8px; 
			margin-top: 12px;
			padding-top: 12px;
			border-top: 1px solid #e2e8f0;
		}
		.ta-truck-actions-primary {
			display: flex;
			gap: 6px;
			width: 100%;
		}
		.ta-truck-actions-primary .btn {
			flex: 1;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			white-space: nowrap;
		}
		.ta-truck-actions-icons {
			display: flex;
			gap: 6px;
			flex-wrap: wrap;
			align-items: center;
		}
		.ta-truck-actions-icons .btn {
			display: inline-flex;
			align-items: center;
			gap: 4px;
		}
		
		.ta-truck-driver { font-size: 12px; color: #475569; margin-bottom: 8px; font-weight:600; }
		.ta-truck-warn {
			background: #fef3c7;
			border: 1px solid #f59e0b;
			border-radius: 4px;
			padding: 6px 10px;
			font-size: 11px;
			color: #92400e;
			margin-bottom: 12px;
		}
		.ta-truck-stats { display: flex; gap: 8px; margin-bottom: 8px; }
		.ta-truck-stat {
			flex: 1;
			background: #ffffff;
			border: 1px solid #e2e8f0;
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
			background: #ffffff;
			border: 1px solid #e2e8f0;
			color: #475569;
			border-radius: 3px;
			padding: 2px 6px;
			font-size: 11px;
		}
		.ta-truck-orders { max-height: 220px; overflow-y: auto; padding-right: 4px; }
		.ta-truck-order {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 8px;
			margin-bottom: 6px;
			background: #f8fafc;
			border: 1px solid #f1f5f9;
			border-radius: 4px;
			font-size: 12px;
		}
		.ta-order-link { font-weight: 600; color: #3b82f6; }
		.ta-order-cust { display: block; color: #6b7280; font-size: 11px; margin-top:2px; }
		.ta-order-loc  { display: block; color: #64748b; font-size: 10px; margin-top:2px; }
		.ta-empty-truck { text-align: center; color: #94a3b8; padding: 10px; font-style: italic; font-size: 12px;}

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
			border-radius: 4px;
		}
		.ta-closed-toggle:hover { background: #f1f5f9; color: #475569; }
		.ta-closed-orders-list { margin-top: 8px; }

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
		/* GPS Badges */
		.ta-gps-badge {
			padding: 2px 6px;
			border-radius: 4px;
			font-size: 10px;
			font-weight: 700;
			text-transform: uppercase;
		}
		.ta-gps-mapped { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
		.ta-gps-missing { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }

		</style>`;
	}
}
