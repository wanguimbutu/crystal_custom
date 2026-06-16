frappe.pages['stock-order-sort'].on_page_load = function (wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Stock & Truck Sorting',
		single_column: true,
	});
	new StockOrderSortManager(page);
};

class StockOrderSortManager {
	constructor(page) {
		this.page = page;
		this.orders = [];
		this.available_trucks = [];
		this.selected = new Set();
		this.item_cache = {};
		this.expanded = new Set();
		this.active_tab = 'stock';
		this.current_page = 1;
		this.page_size = 50;
		this._sps = new Set();
		this.setup_page();
		this.load_trucks();
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	setup_page() {
		const today = frappe.datetime.get_today();

		this.page.add_field({
			label: 'From Date', fieldtype: 'Date', fieldname: 'from_date',
			default: frappe.datetime.add_days(today, -7),
			change: () => { this.current_page = 1; this.render(); },
		});
		this.page.add_field({
			label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
			default: today,
			change: () => { this.current_page = 1; this.render(); },
		});
		this.page.add_field({
			label: 'Delivery Region', fieldtype: 'Link', fieldname: 'delivery_region',
			options: 'Delivery Region',
			change: () => { this.current_page = 1; this.render(); },
		});
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
			},
		});
		this._sp_pills_wrap = $('<div class="sp-pills-wrap"></div>').appendTo(this.page.page_form);

		this.page.set_primary_action('Create Material Request', () => this.create_material_request(), 'octicon octicon-plus');
		this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');

		this.container = $('<div class="sos-container"></div>').appendTo(this.page.main);
	}

	// ── Data loading ──────────────────────────────────────────────────────────

	load_trucks() {
		frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Sales Order',
				fields: ['custom_truck_number'],
				filters: [
					['Sales Order', 'workflow_state', '=', 'Pending Customer Order Reconfirmation'],
					['Sales Order', 'custom_truck_number', '!=', ''],
				],
				limit_page_length: 500,
			},
			callback: (r) => {
				if (r.message) {
					[...new Set(r.message.map(o => o.custom_truck_number).filter(Boolean))].forEach(t => {
						if (!this.available_trucks.find(x => x.truck_number === t)) {
							this.available_trucks.push({ truck_number: t, driver_name: '', capacity_kg: 5000 });
						}
					});
				}
				this.load_data();
			},
		});
	}

	load_data() {
		this.container.html(this._loading_html());

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.stock_order_sort.stock_order_sort.get_orders_with_stock_summary',
			args: { sales_persons: this._sps.size ? [...this._sps] : [] },
			callback: (r) => {
				this.orders = r.message || [];
				this.orders.forEach(o => {
					if (o.custom_truck_number && !this.available_trucks.find(t => t.truck_number === o.custom_truck_number)) {
						this.available_trucks.push({ truck_number: o.custom_truck_number, driver_name: '', capacity_kg: 5000 });
					}
				});
				this.current_page = 1;
				this.render();
			},
		});
	}

	get_filtered_orders() {
		const from   = this.page.fields_dict.from_date.get_value();
		const to     = this.page.fields_dict.to_date.get_value();
		const region = this.page.fields_dict.delivery_region.get_value();
		return this.orders.filter(o => {
			if (from   && o.transaction_date < from)                return false;
			if (to     && o.transaction_date > to)                  return false;
			if (region && o.custom_delivery_region !== region)      return false;
			return true;
		});
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	render() {
		const orders = this.get_filtered_orders();

		if (!orders.length) {
			this.container.html(`
				${this._styles()}
				<div class="sos-tabs">${this._tab_buttons()}</div>
				<div class="alert alert-info" style="margin-top:20px;">
					<strong>No orders awaiting stock check</strong>
					${this.orders.length ? ' — try clearing your filters.' : ' — no orders are currently at the confirmation stage.'}
				</div>`);
			this._attach_tab_events();
			return;
		}

		const ok      = orders.filter(o => o.stock_status === 'ok').length;
		const partial = orders.filter(o => o.stock_status === 'partial').length;
		const none    = orders.filter(o => o.stock_status === 'none').length;
		const trucks_used = new Set(orders.filter(o => o.custom_truck_number).map(o => o.custom_truck_number)).size;

		let html = `${this._styles()}
		<div class="sos-kpi-row">
			${this._kpi('Total Orders',  orders.length, '#667eea')}
			${this._kpi('Stock OK',      ok,            '#10b981')}
			${this._kpi('Partial',       partial,       '#f59e0b')}
			${this._kpi('Insufficient',  none,          none > 0 ? '#ef4444' : '#9ca3af')}
			${this._kpi('Trucks',        trucks_used,   '#8b5cf6')}
		</div>
		<div class="sos-tabs">${this._tab_buttons()}</div>
		<div class="sos-tab-content">
			<div class="sos-tab-pane ${this.active_tab === 'stock' ? 'active' : ''}" id="sos-stock-tab">
				${this._render_stock_tab(orders)}
			</div>
			<div class="sos-tab-pane ${this.active_tab === 'truck' ? 'active' : ''}" id="sos-truck-tab">
				${this._render_truck_tab(orders)}
			</div>
		</div>`;

		this.container.html(html);
		this._attach_events();
	}

	_tab_buttons() {
		return `
			<button class="sos-tab-btn ${this.active_tab === 'stock' ? 'active' : ''}" data-tab="stock">Stock Check</button>
			<button class="sos-tab-btn ${this.active_tab === 'truck' ? 'active' : ''}" data-tab="truck">Truck Arrangement</button>`;
	}

	// ── Stock Check Tab ───────────────────────────────────────────────────────

	_render_stock_tab(all_orders) {
		const total_pages = Math.ceil(all_orders.length / this.page_size) || 1;
		if (this.current_page > total_pages) this.current_page = total_pages;
		const orders = all_orders.slice(
			(this.current_page - 1) * this.page_size,
			this.current_page * this.page_size
		);

		let html = `
		<div class="sos-section">
			<div class="sos-section-header">
				<label style="cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600;margin:0;">
					<input type="checkbox" id="sos-select-all" style="width:16px;height:16px;accent-color:#667eea;">
					Select All (${all_orders.length})
				</label>
				<span class="sos-count-badge">${this.selected.size} selected</span>
			</div>
			<div class="sos-table-wrap">
			<table class="table table-bordered sos-table">
				<thead><tr>
					<th width="3%"></th>
					<th width="3%"></th>
					<th width="12%">Sales Order</th>
					<th width="16%">Customer</th>
					<th width="9%">Date</th>
					<th width="9%">Region</th>
					<th width="10%">Amount</th>
					<th width="8%">Weight</th>
					<th width="11%">Stock Status</th>
					<th width="10%">Truck</th>
				</tr></thead>
				<tbody>`;

		orders.forEach(o => {
			const checked  = this.selected.has(o.name);
			const expanded = this.expanded.has(o.name);

			html += `
			<tr class="sos-row sos-row-${o.stock_status}" data-order="${o.name}">
				<td><input type="checkbox" class="sos-chk" data-order="${o.name}" ${checked ? 'checked' : ''}
				     style="width:16px;height:16px;accent-color:#667eea;cursor:pointer;"></td>
				<td><button class="sos-expand-btn" data-order="${o.name}">${expanded ? '▾' : '▸'}</button></td>
				<td><a href="/app/sales-order/${o.name}" target="_blank" class="sos-link">${o.name}</a></td>
				<td>${frappe.utils.escape_html(o.customer_name || o.customer)}</td>
				<td class="sos-date">${frappe.datetime.str_to_user(o.transaction_date)}</td>
				<td>${o.custom_delivery_region
					? `<span class="sos-tag">${frappe.utils.escape_html(o.custom_delivery_region)}</span>`
					: '<span class="sos-na">—</span>'}
				</td>
				<td class="sos-amt">${format_currency(o.grand_total)}</td>
				<td class="sos-amt">${(o.total_net_weight || 0).toFixed(1)} kg</td>
				<td>${this._stock_badge(o.stock_status)}</td>
				<td>${o.custom_truck_number
					? `<span class="sos-tag">${frappe.utils.escape_html(o.custom_truck_number)}</span>`
					: '<span class="sos-na">—</span>'}
				</td>
			</tr>`;

			if (expanded) {
				html += `
				<tr class="sos-items-row" data-order="${o.name}">
					<td colspan="10">
						<div class="sos-items-wrap" id="sos-items-${o.name}">
							${this._render_items(o.name)}
						</div>
					</td>
				</tr>`;
			}
		});

		html += `</tbody></table>
		${this._pagination_html(all_orders.length)}
		</div></div>`;
		return html;
	}

	_render_items(order_name) {
		const items = this.item_cache[order_name];
		if (!items) {
			this._fetch_items(order_name);
			return `<div class="sos-loading"><i class="fa fa-spinner fa-spin"></i> Loading stock data…</div>`;
		}
		if (!items.length) return `<div class="sos-loading">No pending items.</div>`;

		let html = `
		<table class="sos-items-table">
			<thead><tr>
				<th>Item Code</th><th>Item Name</th>
				<th class="sos-r">Required</th><th class="sos-r">In Stock</th>
				<th class="sos-r">Shortage</th><th>Status</th>
			</tr></thead>
			<tbody>`;

		items.forEach(item => {
			html += `<tr>
				<td><strong>${frappe.utils.escape_html(item.item_code)}</strong></td>
				<td>${frappe.utils.escape_html(item.item_name || '')}</td>
				<td class="sos-r">${item.required_qty.toFixed(2)} ${item.uom || ''}</td>
				<td class="sos-r">${item.available_qty.toFixed(2)}</td>
				<td class="sos-r ${item.shortage > 0 ? 'sos-shortage' : 'sos-ok-cell'}">
					${item.shortage > 0 ? item.shortage.toFixed(2) : '—'}
				</td>
				<td>${item.shortage > 0
					? '<span class="sos-badge-red">Shortage</span>'
					: '<span class="sos-badge-green">Available</span>'}
				</td>
			</tr>`;
		});

		html += `</tbody></table>`;
		return html;
	}

	_fetch_items(order_name) {
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.stock_order_sort.stock_order_sort.get_order_items_with_stock',
			args: { order_name },
			callback: (r) => {
				this.item_cache[order_name] = r.message || [];
				const $wrap = $(`#sos-items-${order_name}`);
				if ($wrap.length) $wrap.html(this._render_items(order_name));
			},
		});
	}

	// ── Truck Arrangement Tab ─────────────────────────────────────────────────

	_render_truck_tab(all_orders) {
		const unassigned = all_orders.filter(o => !o.custom_truck_number);
		const assigned   = all_orders.filter(o =>  o.custom_truck_number);
		const trucks_used = new Set(assigned.map(o => o.custom_truck_number)).size;

		const truck_opts = this.available_trucks.map(t =>
			`<option value="${frappe.utils.escape_html(t.truck_number)}">`
		).join('');

		let html = `
		<datalist id="sos-trucks-list">${truck_opts}</datalist>
		<div class="sos-truck-controls">
			<button class="btn btn-sm btn-default btn-sos-add-truck">+ Add Truck</button>
		</div>`;

		if (this.available_trucks.length) {
			html += `
			<div class="sos-section">
				<div class="sos-section-header">
					Assigned Trucks
					<span class="sos-count-badge">${trucks_used} of ${this.available_trucks.length}</span>
				</div>
				<div class="sos-trucks-grid">`;

			this.available_trucks.forEach(truck => {
				const truck_orders = all_orders.filter(o => o.custom_truck_number === truck.truck_number);
				const total_weight = truck_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
				const total_value  = truck_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
				const cap          = truck.capacity_kg || 0;
				const cap_pct      = cap > 0 ? Math.min((total_weight / cap) * 100, 100).toFixed(0) : 0;
				const is_empty     = !truck_orders.length;

				html += `
				<div class="sos-truck-card${is_empty ? ' sos-truck-empty' : ''}">
					<div class="sos-truck-head">
						<div class="sos-truck-num">${frappe.utils.escape_html(truck.truck_number)}</div>
						<div class="sos-truck-btns">
							<button class="btn btn-xs btn-default btn-sos-edit-truck" data-truck="${frappe.utils.escape_html(truck.truck_number)}" title="Edit">&#9998;</button>
							<button class="btn btn-xs btn-danger  btn-sos-del-truck"  data-truck="${frappe.utils.escape_html(truck.truck_number)}" title="${is_empty ? 'Remove truck' : 'Unassign all orders'}">&#215;</button>
						</div>
					</div>
					${truck.driver_name ? `<div class="sos-truck-driver">${frappe.utils.escape_html(truck.driver_name)}</div>` : ''}
					${!is_empty ? `
					<div class="sos-truck-stats">
						<div class="sos-truck-stat"><span>${truck_orders.length}</span>Orders</div>
						<div class="sos-truck-stat"><span>${total_weight.toFixed(0)} kg</span>Weight</div>
						<div class="sos-truck-stat"><span>${format_currency(total_value, null, 0)}</span>Value</div>
					</div>
					${cap > 0 ? `
					<div class="sos-cap-bar">
						<div class="sos-cap-fill" style="width:${cap_pct}%;background:${cap_pct > 90 ? '#ef4444' : '#10b981'}"></div>
					</div>
					<div class="sos-cap-label">${cap_pct}% capacity (${total_weight.toFixed(0)} / ${cap} kg)</div>
					` : ''}
					<div class="sos-truck-orders">
						${truck_orders.map(o => `
						<div class="sos-truck-order">
							<div>
								<a href="/app/sales-order/${o.name}" target="_blank" class="sos-link">${o.name}</a>
								<span class="sos-order-cust">${frappe.utils.escape_html(o.customer_name || o.customer)}</span>
							</div>
							<div style="display:flex;gap:4px;align-items:center;">
								${this._stock_badge(o.stock_status)}
								<button class="btn btn-xs btn-default btn-sos-unassign" data-order="${o.name}" title="Remove from truck">&#215;</button>
							</div>
						</div>`).join('')}
					</div>
					` : '<div class="sos-empty-truck">No orders assigned</div>'}
				</div>`;
			});

			html += `</div></div>`;
		}

		html += `
		<div class="sos-section">
			<div class="sos-section-header">
				Awaiting Truck Assignment
				<span class="sos-count-badge">${unassigned.length}</span>
			</div>`;

		if (!unassigned.length) {
			html += `<div class="sos-empty">All orders have been assigned to trucks.</div>`;
		} else {
			html += `
			<div class="sos-table-wrap">
			<table class="table table-bordered sos-table">
				<thead><tr>
					<th width="13%">Sales Order</th>
					<th width="19%">Customer</th>
					<th width="11%">Region</th>
					<th width="10%">Amount</th>
					<th width="8%">Weight</th>
					<th width="11%">Stock</th>
					<th width="16%">Assign Truck</th>
				</tr></thead>
				<tbody>`;

			const by_region = {};
			unassigned.forEach(o => {
				const k = o.custom_delivery_region || '__none__';
				if (!by_region[k]) by_region[k] = [];
				by_region[k].push(o);
			});
			const sorted_keys = Object.keys(by_region).sort((a, b) => {
				if (a === '__none__') return 1;
				if (b === '__none__') return -1;
				return a.localeCompare(b);
			});

			sorted_keys.forEach(key => {
				const label = key === '__none__' ? 'No Region' : key;
				const grp   = by_region[key];
				const grp_val = grp.reduce((s, o) => s + (o.grand_total || 0), 0);

				html += `<tr class="sos-group-row">
					<td colspan="7">
						<strong>${frappe.utils.escape_html(label)}</strong>
						<span class="sos-group-meta">${grp.length} order${grp.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ${format_currency(grp_val)}</span>
					</td>
				</tr>`;

				grp.forEach(o => {
					html += `
					<tr class="sos-row sos-row-${o.stock_status}" data-order="${o.name}">
						<td><a href="/app/sales-order/${o.name}" target="_blank" class="sos-link">${o.name}</a></td>
						<td>${frappe.utils.escape_html(o.customer_name || o.customer)}</td>
						<td>${o.custom_delivery_region ? `<span class="sos-tag">${frappe.utils.escape_html(o.custom_delivery_region)}</span>` : '—'}</td>
						<td class="sos-amt">${format_currency(o.grand_total)}</td>
						<td class="sos-amt">${(o.total_net_weight || 0).toFixed(1)} kg</td>
						<td>${this._stock_badge(o.stock_status)}</td>
						<td>
							<input type="text" class="sos-truck-input form-control form-control-sm"
							       list="sos-trucks-list" placeholder="Truck number…"
							       data-order="${o.name}"
							       value="${frappe.utils.escape_html(o.custom_truck_number || '')}">
						</td>
					</tr>`;
				});
			});

			html += `</tbody></table></div>`;
		}

		html += `</div>`;
		return html;
	}

	// ── Events ────────────────────────────────────────────────────────────────

	_attach_events() {
		this._attach_tab_events();

		const self = this;

		// Select all
		this.container.find('#sos-select-all').off('change').on('change', function () {
			const checked = $(this).is(':checked');
			self.container.find('.sos-chk').prop('checked', checked);
			self.get_filtered_orders().forEach(o => {
				checked ? self.selected.add(o.name) : self.selected.delete(o.name);
			});
			// Update count badge without full re-render
			self.container.find('.sos-section-header .sos-count-badge').first().text(`${self.selected.size} selected`);
		});

		// Individual checkbox
		this.container.find('.sos-chk').off('change').on('change', function () {
			const name = $(this).data('order');
			$(this).is(':checked') ? self.selected.add(name) : self.selected.delete(name);
			self.container.find('.sos-section-header .sos-count-badge').first().text(`${self.selected.size} selected`);
		});

		// Expand / collapse
		this.container.find('.sos-expand-btn').off('click').on('click', function () {
			const name = $(this).data('order');
			self.expanded.has(name) ? self.expanded.delete(name) : self.expanded.add(name);
			self.render();
		});

		// Pagination
		this.container.find('.sos-pg-prev').on('click', () => {
			if (this.current_page > 1) { this.current_page--; this.render(); }
		});
		this.container.find('.sos-pg-next').on('click', () => {
			const tp = Math.ceil(this.get_filtered_orders().length / this.page_size);
			if (this.current_page < tp) { this.current_page++; this.render(); }
		});

		// Truck input – assign on change or Enter
		this.container.find('.sos-truck-input').off('change').on('change', function () {
			const order_name   = $(this).data('order');
			const truck_number = $(this).val().trim();
			if (truck_number && !self.available_trucks.find(t => t.truck_number === truck_number)) {
				self.available_trucks.push({ truck_number, driver_name: '', capacity_kg: 5000 });
			}
			self._set_truck(order_name, truck_number);
		});
		this.container.find('.sos-truck-input').off('keydown').on('keydown', function (e) {
			if (e.key === 'Enter') $(this).trigger('change');
		});

		// Unassign
		this.container.find('.btn-sos-unassign').off('click').on('click', function () {
			self._set_truck($(this).data('order'), '');
		});

		// Add truck
		this.container.find('.btn-sos-add-truck').off('click').on('click', () => this.add_truck());

		// Edit truck
		this.container.find('.btn-sos-edit-truck').off('click').on('click', function () {
			self.edit_truck($(this).data('truck'));
		});

		// Delete / unassign truck
		this.container.find('.btn-sos-del-truck').off('click').on('click', function () {
			self.delete_truck($(this).data('truck'));
		});
	}

	_attach_tab_events() {
		const self = this;
		this.container.find('.sos-tab-btn').off('click').on('click', function () {
			const tab = $(this).data('tab');
			self.active_tab = tab;
			self.container.find('.sos-tab-btn').removeClass('active');
			$(this).addClass('active');
			self.container.find('.sos-tab-pane').removeClass('active');
			self.container.find(`#sos-${tab}-tab`).addClass('active');
		});
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	create_material_request() {
		const selected_names = Array.from(this.selected);
		const targets = selected_names.length
			? selected_names
			: this.get_filtered_orders().map(o => o.name);

		if (!targets.length) { frappe.msgprint(__('No orders to create MR for.')); return; }

		const scope = selected_names.length
			? __('selected {0} orders', [selected_names.length])
			: __('all {0} orders in this step', [targets.length]);

		frappe.confirm(
			__('Create a Material Request for shortages across {0}?', [scope]),
			() => {
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.stock_order_sort.stock_order_sort.create_material_request_for_orders',
					args: { order_names: JSON.stringify(targets) },
					freeze: true,
					freeze_message: __('Creating Material Request…'),
					callback: (r) => {
						if (r.message) {
							frappe.msgprint({
								title: __('Success'),
								message: __('Material Request {0} created', [
									`<a href="/app/material-request/${r.message}" target="_blank">${r.message}</a>`
								]),
								indicator: 'green',
							});
						}
					},
					error: () => {
						frappe.msgprint({ title: __('Error'), message: __('No shortages found or failed to create MR'), indicator: 'red' });
					},
				});
			}
		);
	}

	add_truck() {
		frappe.prompt([
			{ label: 'Truck Number', fieldname: 'truck_number', fieldtype: 'Data', reqd: 1 },
			{ label: 'Driver Name',  fieldname: 'driver_name',  fieldtype: 'Data' },
			{ label: 'Capacity (kg)', fieldname: 'capacity_kg', fieldtype: 'Float', default: 5000 },
		], (vals) => {
			if (this.available_trucks.find(t => t.truck_number === vals.truck_number)) {
				frappe.msgprint(__('Truck {0} already exists', [vals.truck_number]));
				return;
			}
			this.available_trucks.push(vals);
			frappe.show_alert({ message: __('Truck {0} added', [vals.truck_number]), indicator: 'green' });
			this.render();
		}, __('Add New Truck'), __('Add'));
	}

	edit_truck(truck_number) {
		const truck = this.available_trucks.find(t => t.truck_number === truck_number);
		frappe.prompt([
			{ label: 'Truck Number', fieldname: 'truck_number', fieldtype: 'Data',  default: truck.truck_number, reqd: 1 },
			{ label: 'Driver Name',  fieldname: 'driver_name',  fieldtype: 'Data',  default: truck.driver_name },
			{ label: 'Capacity (kg)', fieldname: 'capacity_kg', fieldtype: 'Float', default: truck.capacity_kg || 5000 },
		], (vals) => {
			truck.truck_number = vals.truck_number;
			truck.driver_name  = vals.driver_name;
			truck.capacity_kg  = vals.capacity_kg;
			frappe.show_alert({ message: __('Truck updated'), indicator: 'green' });
			this.render();
		}, __('Edit Truck'), __('Update'));
	}

	delete_truck(truck_number) {
		const truck_orders = this.get_filtered_orders().filter(o => o.custom_truck_number === truck_number);
		if (!truck_orders.length) {
			this.available_trucks = this.available_trucks.filter(t => t.truck_number !== truck_number);
			frappe.show_alert({ message: __('Truck removed'), indicator: 'green' });
			this.render();
			return;
		}
		frappe.confirm(
			__('Unassign {0} orders from {1}? They will return to the unassigned list.', [truck_orders.length, truck_number]),
			() => {
				let done = 0;
				const next = () => {
					if (done >= truck_orders.length) {
						this.available_trucks = this.available_trucks.filter(t => t.truck_number !== truck_number);
						this.load_data();
						return;
					}
					frappe.call({
						method: 'crystal_custom.crystal_customizations.page.stock_order_sort.stock_order_sort.set_truck_number',
						args: { order_name: truck_orders[done].name, truck_number: '' },
						callback: () => { done++; next(); },
						error:    () => { done++; next(); },
					});
				};
				next();
			}
		);
	}

	_set_truck(order_name, truck_number) {
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.stock_order_sort.stock_order_sort.set_truck_number',
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

	// ── Helpers ───────────────────────────────────────────────────────────────

	_stock_badge(status) {
		const map = {
			ok:      ['#10b981', '✓ Available'],
			partial: ['#f59e0b', '⚠ Partial'],
			none:    ['#ef4444', '✗ Shortage'],
		};
		const [color, label] = map[status] || ['#9ca3af', '? Unknown'];
		return `<span class="sos-status-badge" style="background:${color}">${label}</span>`;
	}

	_kpi(label, value, color) {
		return `<div class="sos-kpi" style="border-top:4px solid ${color}">
			<div class="sos-kpi-label">${label}</div>
			<div class="sos-kpi-value" style="color:${color}">${value}</div>
		</div>`;
	}

	_loading_html() {
		return `<div style="text-align:center;padding:60px;color:#9ca3af;">
			<i class="fa fa-spinner fa-spin fa-2x"></i><br><br>Loading…
		</div>`;
	}

	_pagination_html(total) {
		if (total <= this.page_size) return '';
		const total_pages = Math.ceil(total / this.page_size);
		const start = (this.current_page - 1) * this.page_size + 1;
		const end   = Math.min(this.current_page * this.page_size, total);
		return `<div class="sos-pg-bar">
			<button class="btn btn-xs btn-default sos-pg-prev" ${this.current_page <= 1 ? 'disabled' : ''}>&lsaquo; Prev</button>
			<span class="sos-pg-info">Showing ${start}–${end} of ${total} &nbsp;·&nbsp; Page ${this.current_page} of ${total_pages}</span>
			<button class="btn btn-xs btn-default sos-pg-next" ${this.current_page >= total_pages ? 'disabled' : ''}>Next &rsaquo;</button>
		</div>`;
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

	// ── Styles ────────────────────────────────────────────────────────────────

	_styles() {
		return `<style>
		.sos-container { margin-top: 16px; }

		/* KPI */
		.sos-kpi-row {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
			gap: 12px;
			margin-bottom: 20px;
		}
		.sos-kpi {
			background: #fff;
			border-radius: 8px;
			padding: 14px 18px;
			box-shadow: 0 1px 4px rgba(0,0,0,.06);
		}
		.sos-kpi-label { font-size: 11px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
		.sos-kpi-value { font-size: 20px; font-weight: 700; margin-top: 4px; }

		/* Tabs */
		.sos-tabs {
			display: flex;
			border-bottom: 2px solid #667eea;
			gap: 4px;
			margin-bottom: 20px;
		}
		.sos-tab-btn {
			background: none;
			border: none;
			border-bottom: 3px solid transparent;
			margin-bottom: -2px;
			padding: 10px 22px;
			font-weight: 600;
			font-size: 14px;
			color: #6b7280;
			cursor: pointer;
			transition: color .2s;
			outline: none;
		}
		.sos-tab-btn:hover { color: #667eea; }
		.sos-tab-btn.active { color: #667eea; border-bottom-color: #667eea; }
		.sos-tab-pane { display: none; }
		.sos-tab-pane.active { display: block; }

		/* Section */
		.sos-section {
			background: #fff;
			border-radius: 8px;
			padding: 16px;
			box-shadow: 0 1px 4px rgba(0,0,0,.06);
			margin-bottom: 20px;
		}
		.sos-section-header {
			font-size: 14px;
			font-weight: 700;
			color: #1e293b;
			margin-bottom: 14px;
			padding-bottom: 10px;
			border-bottom: 2px solid #f1f5f9;
			display: flex;
			align-items: center;
			justify-content: space-between;
		}
		.sos-count-badge {
			background: #667eea;
			color: #fff;
			border-radius: 12px;
			padding: 1px 10px;
			font-size: 12px;
			font-weight: 600;
		}

		/* Table */
		.sos-table-wrap { overflow-x: auto; }
		.sos-table thead th {
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
		.sos-row td { padding: 10px !important; vertical-align: middle !important; font-size: 13px; }
		.sos-row:hover { background: #f8fafc !important; }
		.sos-row-none    { border-left: 3px solid #ef4444 !important; background: #fff5f5; }
		.sos-row-partial { border-left: 3px solid #f59e0b !important; background: #fffbeb; }
		.sos-row-ok      { border-left: 3px solid #10b981 !important; }
		.sos-group-row td {
			background: #f8fafc;
			font-size: 12px;
			padding: 6px 10px !important;
			color: #475569;
			border-top: 2px solid #e2e8f0 !important;
		}
		.sos-group-meta { margin-left: 10px; color: #94a3b8; font-weight: normal; }
		.sos-amt  { text-align: right; font-family: monospace; }
		.sos-date { white-space: nowrap; color: #64748b; }
		.sos-na   { color: #cbd5e1; }
		.sos-link { color: #3b82f6; font-weight: 600; text-decoration: none; }
		.sos-link:hover { text-decoration: underline; }
		.sos-tag {
			display: inline-block;
			padding: 2px 8px;
			background: #f1f5f9;
			border-radius: 4px;
			font-size: 12px;
			color: #475569;
		}
		.sos-status-badge {
			display: inline-block;
			padding: 2px 8px;
			border-radius: 4px;
			font-size: 11px;
			font-weight: 600;
			color: #fff;
			white-space: nowrap;
		}
		.sos-expand-btn {
			background: none;
			border: none;
			cursor: pointer;
			font-size: 16px;
			color: #94a3b8;
			padding: 0 4px;
			transition: color .15s;
		}
		.sos-expand-btn:hover { color: #3b82f6; }

		/* Item detail rows */
		.sos-items-row td { padding: 0 !important; background: #f8fafc; border-bottom: 2px solid #e2e8f0; }
		.sos-items-wrap { padding: 12px 20px; }
		.sos-loading { color: #94a3b8; padding: 12px 20px; font-size: 13px; }
		.sos-items-table { width: 100%; border-collapse: collapse; font-size: 12px; }
		.sos-items-table thead th {
			background: #e2e8f0;
			color: #475569;
			font-size: 11px;
			font-weight: 700;
			text-transform: uppercase;
			padding: 8px 10px;
			border: none;
		}
		.sos-items-table td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: middle; }
		.sos-items-table tr:last-child td { border-bottom: none; }
		.sos-r        { text-align: right !important; }
		.sos-shortage { color: #dc2626; font-weight: 700; }
		.sos-ok-cell  { color: #059669; }
		.sos-badge-red   { background: #fee2e2; color: #dc2626; border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 600; }
		.sos-badge-green { background: #dcfce7; color: #059669; border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 600; }

		/* Pagination */
		.sos-pg-bar {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 14px;
			padding: 12px 16px;
			border-top: 1px solid #e2e8f0;
			background: #f8fafc;
		}
		.sos-pg-info { font-size: 13px; color: #64748b; }
		.sos-pg-bar .btn { min-width: 70px; }

		/* Truck controls */
		.sos-truck-controls { margin-bottom: 16px; }

		/* Truck grid */
		.sos-trucks-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
			gap: 14px;
		}
		.sos-truck-card {
			border: 1px solid #e2e8f0;
			border-radius: 8px;
			padding: 14px;
			background: #fff;
		}
		.sos-truck-card.sos-truck-empty { border: 2px dashed #cbd5e1; background: #f8fafc; }
		.sos-truck-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #f1f5f9; }
		.sos-truck-num  { font-size: 15px; font-weight: 700; color: #1e293b; }
		.sos-truck-btns { display: flex; gap: 4px; }
		.sos-truck-driver { font-size: 12px; color: #6b7280; margin-bottom: 8px; }
		.sos-truck-stats { display: flex; gap: 8px; margin-bottom: 8px; }
		.sos-truck-stat {
			flex: 1;
			background: #f8fafc;
			border-radius: 4px;
			padding: 6px;
			text-align: center;
			font-size: 10px;
			color: #6b7280;
			text-transform: uppercase;
		}
		.sos-truck-stat span { display: block; font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 2px; }
		.sos-cap-bar  { background: #e2e8f0; border-radius: 4px; height: 6px; margin-bottom: 4px; overflow: hidden; }
		.sos-cap-fill { height: 100%; border-radius: 4px; }
		.sos-cap-label { font-size: 10px; color: #6b7280; margin-bottom: 8px; }
		.sos-truck-orders { max-height: 200px; overflow-y: auto; }
		.sos-truck-order {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 6px;
			margin-bottom: 4px;
			background: #f8fafc;
			border-radius: 4px;
			font-size: 12px;
		}
		.sos-order-cust  { display: block; color: #6b7280; font-size: 11px; }
		.sos-empty-truck { text-align: center; color: #94a3b8; padding: 16px; font-style: italic; }
		.sos-empty       { color: #6b7280; font-style: italic; padding: 20px; text-align: center; }
		.sos-truck-input { font-size: 12px; height: 28px; padding: 2px 8px; }
		</style>`;
	}
}
