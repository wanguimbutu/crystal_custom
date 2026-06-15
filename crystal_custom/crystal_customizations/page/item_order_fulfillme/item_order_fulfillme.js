frappe.pages['item-order-fulfillme'].on_page_load = function (wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Order Fulfillment',
		single_column: true,
	});
	new OrderFulfillmentManager(page);
};

class OrderFulfillmentManager {
	constructor(page) {
		this.page        = page;
		this.active_tab  = 'trucks';
		this.summary_data  = [];
		this.truck_data    = { trucks: [], stock: {} };
		this.allocations   = {};   // { item_code: { truck_number: qty } }
		this.search_term   = '';
		this._alloc_save_timer = null;
		this.setup_page();
		this._load_allocations_then_data();
	}

	// Load persisted allocations from server first, then fetch order/stock data
	_load_allocations_then_data() {
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_allocations',
			callback: (r) => {
				try { this.allocations = JSON.parse(r.message || '{}') || {}; } catch(e) {}
				this.load_data();
			},
			error: () => this.load_data(),
		});
	}

	_save_allocations() {
		clearTimeout(this._alloc_save_timer);
		this._alloc_save_timer = setTimeout(() => {
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.save_allocations',
				args: { allocations_json: JSON.stringify(this.allocations) },
			});
		}, 800);
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
			label: 'Search', fieldtype: 'Data', fieldname: 'search_query',
			placeholder: 'Customer, order or item…',
			change: () => {
				this.search_term = this.page.fields_dict.search_query.get_value() || '';
				if (this.active_tab === 'trucks') {
					this.container.find('#tf-trucks-pane').html(this._render_trucks_tab());
				} else {
					this.container.find('#tf-summary-pane').html(this._render_summary_tab());
				}
				this._attach_events();
			},
		});

		this.page.set_primary_action('Create Requisition', () => this.create_requisition(), 'octicon octicon-plus');
		this.page.add_button('Auto Allocate', () => this.auto_allocate());
		this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');

		this.container = $('<div class="tf-container"></div>').appendTo(this.page.main);
	}

	// ── Data loading ──────────────────────────────────────────────────────────

	load_data() {
		this.container.html(this._loading_html());

		const from_date = this.page.fields_dict.from_date.get_value();
		const to_date   = this.page.fields_dict.to_date.get_value();

		const prev_stock = this.truck_data ? { ...this.truck_data.stock } : {};

		// Load both tabs in parallel
		Promise.all([
			new Promise(resolve => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_sales_order_fulfillment',
				args: { from_date, to_date },
				callback: r => { this.summary_data = r.message || []; resolve(); },
				error: () => resolve(),
			})),
			new Promise(resolve => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_truck_fulfillment_data',
				args: { from_date, to_date },
				callback: r => { this.truck_data = r.message || { trucks: [], stock: {} }; resolve(); },
				error: () => resolve(),
			})),
		]).then(() => {
			// Detect stock changes and notify
			const changed = Object.keys(this.truck_data.stock).filter(ic => {
				const old_qty = (prev_stock[ic] || {}).available_qty;
				const new_qty = (this.truck_data.stock[ic] || {}).available_qty;
				return old_qty !== undefined && old_qty !== new_qty;
			});
			if (changed.length) {
				frappe.show_alert({
					message: __('Stock levels changed for {0} item(s) — shortages recalculated', [changed.length]),
					indicator: 'orange',
				}, 6);
			}
			this.render();
		});
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	render() {
		const trucks_badge = this.truck_data.trucks.length;
		const items_badge  = this.summary_data.length;

		let html = `${this._styles()}
		<div class="tf-tabs">
			<button class="tf-tab-btn ${this.active_tab === 'trucks'  ? 'active' : ''}" data-tab="trucks">
				Truck Fulfillment
				${trucks_badge ? `<span class="tf-tab-badge">${trucks_badge}</span>` : ''}
			</button>
			<button class="tf-tab-btn ${this.active_tab === 'summary' ? 'active' : ''}" data-tab="summary">
				Item Summary
				${items_badge ? `<span class="tf-tab-badge">${items_badge}</span>` : ''}
			</button>
		</div>
		<div class="tf-tab-content">
			<div class="tf-tab-pane ${this.active_tab === 'trucks'  ? 'active' : ''}" id="tf-trucks-pane">
				${this._render_trucks_tab()}
			</div>
			<div class="tf-tab-pane ${this.active_tab === 'summary' ? 'active' : ''}" id="tf-summary-pane">
				${this._render_summary_tab()}
			</div>
		</div>`;

		this.container.html(html);
		this._attach_events();
	}

	// ── Trucks Tab ────────────────────────────────────────────────────────────

	_truck_has_shortage(truck) {
		return truck.items.some(item => {
			const alloc = (this.allocations[item.item_code] || {})[truck.truck_number] || 0;
			return item.required_qty > alloc;
		});
	}

	_render_trucks_tab() {
		let trucks = this.truck_data.trucks;

		if (this.search_term) {
			const q = this.search_term.toLowerCase();
			trucks = trucks.filter(t =>
				(t.truck_number || '').toLowerCase().includes(q) ||
				(t.orders || []).some(o =>
					(o.name          || '').toLowerCase().includes(q) ||
					(o.customer_name || '').toLowerCase().includes(q)
				)
			);
		}

		if (!trucks.length) {
			return `<div class="alert alert-info" style="margin-top:20px;">
				<strong>${this.search_term ? 'No trucks match your search.' : 'No trucks with assigned orders'}</strong>
				${!this.search_term ? ' — assign orders to trucks in the Truck Assignment page first.' : ''}
			</div>`;
		}

		// Trucks with shortages first, then fully allocated, then empty
		trucks = [...trucks].sort((a, b) => {
			const a_short = a.items.length > 0 && this._truck_has_shortage(a);
			const b_short = b.items.length > 0 && this._truck_has_shortage(b);
			if (a_short !== b_short) return b_short ? 1 : -1;
			return (a.truck_number || '').localeCompare(b.truck_number || '');
		});

		const item_summary = this._compute_item_summary();
		const has_any_short = Object.values(item_summary).some(s => s.total_short > 0);

		// KPI row
		const total_items    = Object.keys(item_summary).length;
		const items_ok       = Object.values(item_summary).filter(s => s.total_short <= 0).length;
		const items_short    = total_items - items_ok;
		const total_shortage = Object.values(item_summary).reduce((a, s) => a + s.total_short, 0);

		let html = `
		<div class="tf-kpi-row">
			${this._kpi('Trucks', trucks.length, '#8b5cf6')}
			${this._kpi('Items Needed', total_items, '#667eea')}
			${this._kpi('Fully Stocked', items_ok, '#10b981')}
			${this._kpi('With Shortages', items_short, items_short > 0 ? '#ef4444' : '#9ca3af')}
		</div>

		<div class="tf-section">
			<div class="tf-section-header">
				Item Stock Overview
				<span class="tf-header-note">Allocate stock to trucks using the inputs in each truck card</span>
			</div>
			<div id="tf-item-overview">
				${this._render_item_overview(item_summary)}
			</div>
		</div>

		<div class="tf-section">
			<div class="tf-section-header">Truck Allocations</div>
			<div class="tf-trucks-grid" id="tf-trucks-grid">
				${trucks.map(t => this._render_truck_card(t, item_summary)).join('')}
			</div>
		</div>`;

		return html;
	}

	_compute_item_summary() {
		const summary = {};

		this.truck_data.trucks.forEach(truck => {
			truck.items.forEach(item => {
				if (!summary[item.item_code]) {
					summary[item.item_code] = {
						item_code:      item.item_code,
						item_name:      item.item_name,
						uom:            item.uom,
						total_required: 0,
						in_stock:       (this.truck_data.stock[item.item_code] || {}).available_qty || 0,
					};
				}
				summary[item.item_code].total_required += item.required_qty;
			});
		});

		Object.keys(summary).forEach(ic => {
			const s       = summary[ic];
			const alloc   = this.allocations[ic] || {};
			s.total_allocated = Object.values(alloc).reduce((a, b) => a + b, 0);
			s.remaining_stock = Math.max(0, s.in_stock - s.total_allocated);
			s.total_short     = Math.max(0, s.total_required - s.in_stock);
		});

		return summary;
	}

	_get_available_for_truck(item_code, truck_number) {
		const in_stock = (this.truck_data.stock[item_code] || {}).available_qty || 0;
		const alloc    = this.allocations[item_code] || {};
		const others   = Object.entries(alloc)
			.filter(([tn]) => tn !== truck_number)
			.reduce((s, [, v]) => s + v, 0);
		return Math.max(0, in_stock - others);
	}

	_render_item_overview(item_summary) {
		const items = Object.values(item_summary).sort((a, b) => b.total_short - a.total_short);

		if (!items.length) return '<div class="tf-empty">No items.</div>';

		let html = `<table class="table table-bordered tf-table">
			<thead><tr>
				<th>Item Code</th><th>Description</th>
				<th class="tf-r">Total Needed</th>
				<th class="tf-r">In Stock</th>
				<th class="tf-r">Allocated</th>
				<th class="tf-r">Remaining</th>
				<th class="tf-r">Short</th>
			</tr></thead><tbody>`;

		items.forEach(s => {
			const ic = this._sid(s.item_code);
			html += `<tr>
				<td><strong>${frappe.utils.escape_html(s.item_code)}</strong></td>
				<td>${frappe.utils.escape_html(s.item_name)}</td>
				<td class="tf-r">${s.total_required.toFixed(2)} ${s.uom}</td>
				<td class="tf-r ${s.in_stock < s.total_required ? 'tf-warn' : 'tf-ok'}">
					${s.in_stock.toFixed(2)}
				</td>
				<td class="tf-r" id="tf-ov-alloc-${ic}">${s.total_allocated.toFixed(2)}</td>
				<td class="tf-r" id="tf-ov-rem-${ic}">${s.remaining_stock.toFixed(2)}</td>
				<td class="tf-r ${s.total_short > 0 ? 'tf-short' : 'tf-ok'}" id="tf-ov-short-${ic}">
					${s.total_short > 0 ? `<strong>${s.total_short.toFixed(2)}</strong>` : '—'}
				</td>
			</tr>`;
		});

		html += '</tbody></table>';
		return html;
	}

	_render_truck_card(truck, item_summary) {
		const tn  = truck.truck_number;
		const sid = this._sid(tn);

		let fully_allocated = true;
		let any_items = truck.items.length > 0;

		let rows = '';
		truck.items.forEach(item => {
			const ic          = item.item_code;
			const alloc_map   = this.allocations[ic] || {};
			const truck_alloc = alloc_map[tn] || 0;
			const avail       = this._get_available_for_truck(ic, tn);
			const max_alloc   = Math.min(item.required_qty, truck_alloc + avail);
			const short       = Math.max(0, item.required_qty - truck_alloc);
			if (short > 0) fully_allocated = false;

			const isic = this._sid(ic);

			rows += `<tr>
				<td><strong>${frappe.utils.escape_html(ic)}</strong></td>
				<td class="tf-item-name">${frappe.utils.escape_html(item.item_name)}</td>
				<td class="tf-r">${item.required_qty.toFixed(2)} ${item.uom}</td>
				<td class="tf-r">
					<input type="number" class="tf-alloc-input"
					       data-truck="${frappe.utils.escape_html(tn)}"
					       data-item="${frappe.utils.escape_html(ic)}"
					       value="${truck_alloc}"
					       min="0" max="${max_alloc.toFixed(3)}" step="0.001">
				</td>
				<td class="tf-r tf-short-cell ${short > 0 ? 'tf-short' : 'tf-ok'}"
				    id="tf-short-${sid}-${isic}">
					${short > 0 ? `<strong>${short.toFixed(2)}</strong>` : '—'}
				</td>
			</tr>`;
		});

		const status_label = !any_items ? 'No Items'
			: fully_allocated ? 'Fully Allocated'
			: 'Has Shortages';
		const status_color = !any_items ? '#9ca3af'
			: fully_allocated ? '#10b981'
			: '#ef4444';

		// Orders list inside the card
		const orders_html = (truck.orders || []).map(o => `
			<div class="tf-order-row">
				<div>
					<a href="/app/sales-order/${o.name}" target="_blank" class="tf-order-link">${o.name}</a>
					<span class="tf-order-cust">${frappe.utils.escape_html(o.customer_name)}</span>
				</div>
				<button class="btn btn-xs btn-danger btn-remove-order"
				        data-order="${o.name}" data-truck="${frappe.utils.escape_html(tn)}"
				        title="Remove from truck">Remove</button>
			</div>`).join('');

		return `
		<div class="tf-truck-card">
			<div class="tf-truck-head">
				<div>
					<span class="tf-truck-num">${frappe.utils.escape_html(tn)}</span>
					<span class="tf-truck-meta">
						${truck.order_count} order${truck.order_count !== 1 ? 's' : ''}
						${truck.total_weight ? ` &nbsp;·&nbsp; ${truck.total_weight.toFixed(0)} kg` : ''}
					</span>
				</div>
				<span class="tf-status-badge" id="tf-status-${sid}" style="background:${status_color}">
					${status_label}
				</span>
			</div>

			${truck.orders && truck.orders.length ? `
			<div class="tf-orders-section">
				<div class="tf-orders-toggle" data-sid="${sid}">
					▸ Orders in this truck (${truck.orders.length})
				</div>
				<div class="tf-orders-list" id="tf-orders-list-${sid}" style="display:none;">
					${orders_html}
				</div>
			</div>` : ''}

			${any_items ? `
			<table class="tf-card-table">
				<thead><tr>
					<th>Item</th><th>Name</th>
					<th class="tf-r">Required</th>
					<th class="tf-r">From Stock</th>
					<th class="tf-r">Short</th>
				</tr></thead>
				<tbody>${rows}</tbody>
			</table>` : '<div class="tf-empty">No pending items in this truck.</div>'}
		</div>`;
	}

	// ── Summary Tab (existing per-item view) ──────────────────────────────────

	_render_summary_tab() {
		let data = this.summary_data;

		if (this.search_term) {
			const q = this.search_term.toLowerCase();
			data = data.filter(d =>
				(d.item_code || '').toLowerCase().includes(q) ||
				(d.item_name || '').toLowerCase().includes(q)
			);
		}

		if (!data.length) {
			return `<div class="alert alert-info" style="margin-top:20px;">
				<strong>${this.search_term ? 'No items match your search.' : 'No items found — no finance-approved orders in this date range.'}</strong>
			</div>`;
		}

		const total_items = data.length;
		const short_items = data.filter(d => d.shortage > 0).length;
		const total_short = data.reduce((a, d) => a + d.shortage, 0);

		let html = `
		<div class="tf-kpi-row">
			${this._kpi('Items',         total_items, '#667eea')}
			${this._kpi('With Shortages', short_items, short_items > 0 ? '#ef4444' : '#9ca3af')}
		</div>
		<div class="tf-section">
			<table class="table table-bordered tf-table">
				<thead><tr>
					<th>Item Code</th><th>Item Name</th>
					<th class="tf-r">Required</th>
					<th class="tf-r">Available</th>
					<th class="tf-r">Shortage</th>
					<th>Status</th>
				</tr></thead><tbody>`;

		data.forEach(row => {
			const has_short = row.shortage > 0;
			html += `<tr>
				<td><strong>${frappe.utils.escape_html(row.item_code)}</strong></td>
				<td>${frappe.utils.escape_html(row.item_name)}</td>
				<td class="tf-r">${row.required_qty.toFixed(2)}</td>
				<td class="tf-r ${has_short ? 'tf-warn' : 'tf-ok'}">${row.available_qty.toFixed(2)}</td>
				<td class="tf-r ${has_short ? 'tf-short' : 'tf-ok'}">
					${has_short ? `<strong>${row.shortage.toFixed(2)}</strong>` : '—'}
				</td>
				<td>
					<span class="tf-status-badge" style="background:${has_short ? '#ef4444' : '#10b981'}">
						${has_short ? 'Insufficient' : 'Adequate'}
					</span>
				</td>
			</tr>`;
		});

		html += `</tbody></table>
		<div style="margin-top:12px;">
			<button class="btn btn-primary btn-sm btn-create-mr-summary">
				Create Material Request for All Shortages
			</button>
		</div>
		</div>`;

		return html;
	}

	// ── Events ────────────────────────────────────────────────────────────────

	_attach_events() {
		const self = this;

		// Tab switching
		this.container.find('.tf-tab-btn').on('click', function () {
			const tab = $(this).data('tab');
			self.active_tab = tab;
			self.search_term = '';
			if (self.page.fields_dict.search_query) {
				self.page.fields_dict.search_query.set_value('');
			}
			self.container.find('.tf-tab-btn').removeClass('active');
			$(this).addClass('active');
			self.container.find('.tf-tab-pane').removeClass('active');
			self.container.find(`#tf-${tab}-pane`).addClass('active');
		});

		// Allocation input (delegated — works after re-render)
		this.container.off('input.tf-alloc').on('input.tf-alloc', '.tf-alloc-input', function () {
			const tn    = $(this).data('truck');
			const ic    = $(this).data('item');
			let   value = parseFloat($(this).val()) || 0;

			// Clamp to max
			const max = parseFloat($(this).attr('max')) || 0;
			if (value > max) { value = max; $(this).val(max); }

			if (!self.allocations[ic]) self.allocations[ic] = {};
			self.allocations[ic][tn] = value;

			self._update_allocations_in_place(ic, tn);
			self._save_allocations();
		});

		// Orders list toggle
		this.container.off('click.tf-toggle').on('click.tf-toggle', '.tf-orders-toggle', function () {
			const sid   = $(this).data('sid');
			const $list = $(`#tf-orders-list-${sid}`);
			const open  = $list.is(':visible');
			$list.slideToggle(150);
			$(this).text(open
				? `▸ Orders in this truck (${$list.children().length})`
				: `▾ Orders in this truck (${$list.children().length})`);
		});

		// Remove order from truck
		this.container.off('click.tf-remove').on('click.tf-remove', '.btn-remove-order', function () {
			self._remove_order_from_truck($(this).data('order'), $(this).data('truck'));
		});

		// Summary tab: create MR button
		this.container.off('click.tf-mr').on('click.tf-mr', '.btn-create-mr-summary', () => {
			this._create_mr_from_summary();
		});
	}

	// ── In-place DOM update after allocation change ───────────────────────────

	_update_allocations_in_place(changed_ic, changed_tn) {
		const item_summary = this._compute_item_summary();

		// Update overview table cells for affected item
		Object.keys(item_summary).forEach(ic => {
			const s   = item_summary[ic];
			const sid = this._sid(ic);
			$(`#tf-ov-alloc-${sid}`).text(s.total_allocated.toFixed(2));
			$(`#tf-ov-rem-${sid}`).text(s.remaining_stock.toFixed(2));
			const $short = $(`#tf-ov-short-${sid}`);
			$short.removeClass('tf-short tf-ok').addClass(s.total_short > 0 ? 'tf-short' : 'tf-ok');
			$short.html(s.total_short > 0 ? `<strong>${s.total_short.toFixed(2)}</strong>` : '—');
		});

		// Update all truck cards that contain the changed item
		this.truck_data.trucks.forEach(truck => {
			const tn  = truck.truck_number;
			const sid = this._sid(tn);

			truck.items.forEach(item => {
				const ic    = item.item_code;
				const alloc = (this.allocations[ic] || {})[tn] || 0;
				const avail = this._get_available_for_truck(ic, tn);
				const max   = Math.min(item.required_qty, alloc + avail);
				const short = Math.max(0, item.required_qty - alloc);

				// Update max attribute on the input
				this.container.find(
					`.tf-alloc-input[data-truck="${tn}"][data-item="${ic}"]`
				).attr('max', max.toFixed(3));

				// Update the shortage cell for this truck + item
				const isid  = this._sid(ic);
				const $cell = $(`#tf-short-${sid}-${isid}`);
				$cell.removeClass('tf-short tf-ok').addClass(short > 0 ? 'tf-short' : 'tf-ok');
				$cell.html(short > 0 ? `<strong>${short.toFixed(2)}</strong>` : '—');
			});

			// Update truck status badge
			const truck_has_short = truck.items.some(item => {
				const alloc = (this.allocations[item.item_code] || {})[tn] || 0;
				return item.required_qty > alloc;
			});
			const label = truck.items.length === 0 ? 'No Items'
				: truck_has_short ? 'Has Shortages' : 'Fully Allocated';
			const color = truck.items.length === 0 ? '#9ca3af'
				: truck_has_short ? '#ef4444' : '#10b981';
			$(`#tf-status-${sid}`)
				.text(label)
				.css('background', color);
		});
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	_remove_order_from_truck(order_name, truck_number) {
		frappe.confirm(
			__('Remove {0} from truck {1}? The order stays at Pending Confirmation — you can re-assign it later.', [order_name, truck_number]),
			() => {
				frappe.call({
					method: 'frappe.client.set_value',
					args: { doctype: 'Sales Order', name: order_name, fieldname: 'custom_truck_number', value: '' },
					callback: () => {
						frappe.show_alert({ message: __('Order removed from truck — truck weights recalculated'), indicator: 'orange' });
						this.load_data();
					},
				});
			}
		);
	}

	auto_allocate() {
		if (!this.truck_data.trucks.length) {
			frappe.msgprint(__('No trucks to allocate.'));
			return;
		}

		// Reset allocations
		this.allocations = {};

		// For each item, fill trucks in order until stock runs out
		const trucks  = this.truck_data.trucks;
		const stock   = this.truck_data.stock;

		// Collect all unique item codes
		const all_items = new Set();
		trucks.forEach(t => t.items.forEach(i => all_items.add(i.item_code)));

		all_items.forEach(ic => {
			let remaining = (stock[ic] || {}).available_qty || 0;
			this.allocations[ic] = {};

			trucks.forEach(truck => {
				if (remaining <= 0) {
					this.allocations[ic][truck.truck_number] = 0;
					return;
				}
				const needed = (truck.items.find(i => i.item_code === ic) || {}).required_qty || 0;
				const give   = Math.min(needed, remaining);
				this.allocations[ic][truck.truck_number] = give;
				remaining -= give;
			});
		});

		// Persist and re-render
		this._save_allocations();
		this.container.find('#tf-trucks-pane').html(this._render_trucks_tab());
		this._attach_events();
		frappe.show_alert({ message: __('Stock auto-allocated to trucks'), indicator: 'green' });
	}

	create_requisition() {
		if (!this.truck_data.trucks.length) {
			frappe.msgprint(__('No truck data loaded.'));
			return;
		}

		const item_summary = this._compute_item_summary();
		const shortage_items = Object.values(item_summary)
			.filter(s => s.total_short > 0)
			.map(s => ({
				item_code:    s.item_code,
				item_name:    s.item_name,
				shortage_qty: s.total_short,
				uom:          s.uom,
			}));

		if (!shortage_items.length) {
			frappe.msgprint({ title: __('No Shortages'), message: __('All items have sufficient stock.'), indicator: 'green' });
			return;
		}

		frappe.confirm(
			__('Create a Material Request for {0} item(s) with shortages?', [shortage_items.length]),
			() => {
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.create_requisition_from_shortage_items',
					args: { shortage_items: JSON.stringify(shortage_items) },
					freeze: true,
					freeze_message: __('Creating Material Request…'),
					callback: (r) => {
						if (r.message) {
							frappe.msgprint({
								title: __('Requisition Created'),
								message: __('Material Request {0} created', [
									`<a href="/app/material-request/${r.message}" target="_blank">${r.message}</a>`
								]),
								indicator: 'green',
							});
						}
					},
				});
			}
		);
	}

	_create_mr_from_summary() {
		const from_date = this.page.fields_dict.from_date.get_value();
		const to_date   = this.page.fields_dict.to_date.get_value();
		frappe.confirm(
			__('Create a Material Request for all shortages in this date range?'),
			() => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.create_material_request_from_shortage',
				args: { from_date, to_date },
				freeze: true,
				freeze_message: __('Creating Material Request…'),
				callback: (r) => {
					if (r.message) {
						frappe.msgprint({
							title: __('Done'),
							message: __('Material Request {0} created', [
								`<a href="/app/material-request/${r.message}" target="_blank">${r.message}</a>`
							]),
							indicator: 'green',
						});
					}
				},
				error: () => frappe.msgprint({ title: __('Error'), message: __('No shortages found'), indicator: 'red' }),
			})
		);
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	/** Convert any string to a safe DOM id segment. */
	_sid(str) {
		return String(str).replace(/[^a-zA-Z0-9]/g, '_');
	}

	_kpi(label, value, color) {
		return `<div class="tf-kpi" style="border-top:4px solid ${color}">
			<div class="tf-kpi-label">${label}</div>
			<div class="tf-kpi-value" style="color:${color}">${value}</div>
		</div>`;
	}

	_loading_html() {
		return `<div style="text-align:center;padding:60px;color:#9ca3af;">
			<i class="fa fa-spinner fa-spin fa-2x"></i><br><br>Loading…
		</div>`;
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	_styles() {
		return `<style>
		.tf-container { margin-top: 16px; }

		/* Search bar */
		.tf-search-row {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 16px;
		}
		.tf-search-input {
			max-width: 340px;
			height: 34px;
			font-size: 13px;
			border-radius: 6px;
		}
		.tf-search-count {
			font-size: 12px;
			color: #6b7280;
			background: #fef3c7;
			border: 1px solid #fcd34d;
			border-radius: 4px;
			padding: 1px 8px;
		}

		/* Tabs */
		.tf-tabs {
			display: flex;
			border-bottom: 2px solid #667eea;
			gap: 4px;
			margin-bottom: 20px;
		}
		.tf-tab-btn {
			background: none;
			border: none;
			border-bottom: 3px solid transparent;
			margin-bottom: -2px;
			padding: 10px 20px;
			font-weight: 600;
			font-size: 14px;
			color: #6b7280;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 6px;
			outline: none;
			transition: color .2s;
		}
		.tf-tab-btn:hover { color: #667eea; }
		.tf-tab-btn.active { color: #667eea; border-bottom-color: #667eea; }
		.tf-tab-badge {
			background: #667eea;
			color: #fff;
			border-radius: 10px;
			padding: 1px 7px;
			font-size: 11px;
			font-weight: 700;
		}
		.tf-tab-pane { display: none; }
		.tf-tab-pane.active { display: block; }

		/* KPI */
		.tf-kpi-row {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
			gap: 12px;
			margin-bottom: 20px;
		}
		.tf-kpi {
			background: #fff;
			border-radius: 8px;
			padding: 14px 18px;
			box-shadow: 0 1px 4px rgba(0,0,0,.06);
		}
		.tf-kpi-label { font-size: 11px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
		.tf-kpi-value { font-size: 20px; font-weight: 700; margin-top: 4px; }

		/* Section */
		.tf-section {
			background: #fff;
			border-radius: 8px;
			padding: 16px;
			box-shadow: 0 1px 4px rgba(0,0,0,.06);
			margin-bottom: 20px;
			overflow-x: auto;
		}
		.tf-section-header {
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
		.tf-header-note { font-size: 12px; font-weight: 400; color: #94a3b8; }

		/* Tables */
		.tf-table thead th {
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
		.tf-table td { padding: 9px 10px !important; vertical-align: middle !important; font-size: 13px; }
		.tf-table tr:hover td { background: #f8fafc; }
		.tf-r   { text-align: right !important; }
		.tf-ok   { color: #059669; font-weight: 600; }
		.tf-warn { color: #d97706; font-weight: 600; }
		.tf-short { color: #dc2626; }
		.tf-empty { color: #9ca3af; font-style: italic; padding: 16px; text-align: center; }

		/* Status badge */
		.tf-status-badge {
			display: inline-block;
			padding: 3px 10px;
			border-radius: 4px;
			font-size: 11px;
			font-weight: 600;
			color: #fff;
			white-space: nowrap;
		}

		/* Allocation input */
		.tf-alloc-input {
			width: 90px;
			height: 26px;
			padding: 2px 6px;
			font-size: 12px;
			text-align: right;
			border: 1px solid #cbd5e1;
			border-radius: 4px;
			background: #f0fdf4;
			transition: border-color .15s, box-shadow .15s;
		}
		.tf-alloc-input:focus {
			outline: none;
			border-color: #10b981;
			box-shadow: 0 0 0 2px rgba(16,185,129,.15);
			background: #fff;
		}

		/* Truck grid */
		.tf-trucks-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
			gap: 16px;
		}
		.tf-truck-card {
			border: 1px solid #e2e8f0;
			border-radius: 8px;
			overflow: hidden;
			background: #fff;
			box-shadow: 0 1px 4px rgba(0,0,0,.05);
		}
		.tf-truck-head {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 12px 14px;
			background: #1e293b;
		}
		.tf-truck-num  { font-size: 15px; font-weight: 700; color: #f1f5f9; }
		.tf-truck-meta { font-size: 12px; color: #94a3b8; margin-top: 2px; }
		.tf-card-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}
		.tf-card-table thead th {
			background: #f1f5f9;
			color: #475569;
			font-size: 11px;
			font-weight: 700;
			text-transform: uppercase;
			padding: 7px 10px;
			border-bottom: 1px solid #e2e8f0;
			white-space: nowrap;
		}
		.tf-card-table td {
			padding: 8px 10px;
			border-bottom: 1px solid #f1f5f9;
			vertical-align: middle;
		}
		.tf-card-table tr:last-child td { border-bottom: none; }
		.tf-card-table tr:hover td { background: #f8fafc; }
		.tf-item-name { color: #64748b; max-width: 160px; }
		.tf-short-cell { font-family: monospace; }

		/* Orders in truck */
		.tf-orders-section { border-top: 1px solid #f1f5f9; }
		.tf-orders-toggle {
			padding: 8px 14px;
			font-size: 12px;
			font-weight: 600;
			color: #475569;
			cursor: pointer;
			background: #f8fafc;
			user-select: none;
		}
		.tf-orders-toggle:hover { background: #f1f5f9; }
		.tf-orders-list { border-top: 1px solid #f1f5f9; }
		.tf-order-row {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 7px 14px;
			border-bottom: 1px solid #f1f5f9;
			font-size: 12px;
		}
		.tf-order-row:last-child { border-bottom: none; }
		.tf-order-link { font-weight: 600; color: #3b82f6; text-decoration: none; }
		.tf-order-link:hover { text-decoration: underline; }
		.tf-order-cust { display: block; color: #94a3b8; font-size: 11px; margin-top: 1px; }
		</style>`;
	}
}
