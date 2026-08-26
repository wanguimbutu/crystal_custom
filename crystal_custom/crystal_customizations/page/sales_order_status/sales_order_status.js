frappe.pages['sales-order-status'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Sales Order Status',
		single_column: true,
	});
	new SalesOrderStatusPage(page);
};

class SalesOrderStatusPage {
	constructor(page) {
		this.page = page;
		this.orders = [];
		this.active_state_filter = null;
		this.search_term = '';
		this.current_page = 1;
		this.page_size = 50;
		this.view_mode = 'orders'; // 'orders' | 'trucks'
		this.truck_meta = {};      // keyed by truck_number → {driver_name, capacity_kg}
		this.closed_trucks = [];
		this._sps = new Set();
		this.setup_page();
		this.set_default_dates();
		this.load_data();
	}

	setup_page() {
		const today = frappe.datetime.get_today();

		this.page.add_field({
			label: 'From Date', fieldtype: 'Date', fieldname: 'from_date',
			change: () => { this.active_state_filter = null; this.current_page = 1; this.load_data(); }
		});
		this.page.add_field({
			label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
			change: () => { this.active_state_filter = null; this.current_page = 1; this.load_data(); }
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
				this.active_state_filter = null; this.current_page = 1; this.load_data();
			}
		});
		this._sp_pills_wrap = $('<div class="sp-pills-wrap"></div>').appendTo(this.page.page_form);
		this.page.add_field({
			label: 'Delivery Region', fieldtype: 'Link', fieldname: 'delivery_region',
			options: 'Delivery Region',
			change: () => { this.active_state_filter = null; this.current_page = 1; this.load_data(); }
		});
		this.page.add_field({
			label: 'Search', fieldtype: 'Data', fieldname: 'search_query',
			placeholder: 'Customer or order no…',
			change: () => {
				this.search_term = this.page.fields_dict.search_query.get_value() || '';
				this.current_page = 1;
				this.render();
			},
		});

		this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');

		this.container = $('<div class="sos-container"></div>').appendTo(this.page.main);
	}

	set_default_dates() {
		const today = frappe.datetime.get_today();
		this.page.fields_dict.from_date.set_value(today);
		this.page.fields_dict.to_date.set_value(today);
	}

	load_data() {
		const from_date = this.page.fields_dict.from_date.get_value();
		const to_date   = this.page.fields_dict.to_date.get_value();
		if (!from_date || !to_date) return;

		this.container.html(this._loading_html());

		let orders_done = false, meta_done = false, closed_done = false;
		const try_render = () => {
			if (orders_done && meta_done && closed_done) {
				this.current_page = 1;
				this.render();
			}
		};

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_status.sales_order_status.get_daily_orders',
			args: {
				from_date,
				to_date,
				sales_persons_json: this._sps.size ? JSON.stringify([...this._sps]) : null,
				delivery_region: this.page.fields_dict.delivery_region.get_value() || null,
			},
			callback: (r) => {
				this.orders = r.message || [];
				orders_done = true;
				try_render();
			},
			error: () => {
				this.orders = [];
				orders_done = true;
				try_render();
			}
		});

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_meta',
			callback: (r) => {
				this.truck_meta = {};
				try {
					(JSON.parse(r.message || '[]') || []).forEach(t => {
						this.truck_meta[t.truck_number] = t;
					});
				} catch(e) {}
				meta_done = true;
				try_render();
			},
			error: () => { meta_done = true; try_render(); }
		});

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_closed_trucks',
			callback: (r) => {
				try { this.closed_trucks = JSON.parse(r.message || '[]') || []; } catch(e) { this.closed_trucks = []; }
				closed_done = true;
				try_render();
			},
			error: () => { this.closed_trucks = []; closed_done = true; try_render(); },
		});
	}

	// ── State definitions ─────────────────────────────────────────────────────

	_states() {
		return [
			{ key: 'Proceed To Order',                      label: 'New Orders',         color: '#6b7280', icon: '📋' },
			{ key: 'Pending Finance Approval',              label: 'Finance Review',      color: '#f59e0b', icon: '💰' },
			{ key: 'Pending Customer Order Reconfirmation', label: 'Awaiting Confirm',    color: '#3b82f6', icon: '📞' },
			{ key: 'Order Confirmed',                       label: 'Confirmed',           color: '#10b981', icon: '✅' },
		];
	}

	_get_filtered_orders() {
		let orders = this.active_state_filter
			? this.orders.filter(o => o.workflow_state === this.active_state_filter)
			: this.orders;
		if (this.search_term) {
			const q = this.search_term.toLowerCase();
			orders = orders.filter(o =>
				(o.name          || '').toLowerCase().includes(q) ||
				(o.customer_name || '').toLowerCase().includes(q) ||
				(o.customer      || '').toLowerCase().includes(q)
			);
		}
		return orders;
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	render() {
		const all = this._get_filtered_orders();
		const total_pages = Math.ceil(all.length / this.page_size) || 1;
		if (this.current_page > total_pages) this.current_page = total_pages;
		const page_orders = all.slice(
			(this.current_page - 1) * this.page_size,
			this.current_page * this.page_size
		);

		const total_value = this.orders.reduce((s, o) => s + (o.grand_total || 0), 0);
		const delivered   = this.orders.filter(o => (o.per_delivered || 0) >= 100).length;
		const invoiced    = this.orders.filter(o => (o.per_billed    || 0) >= 100).length;

		let html = `
		<div class="sos-summary-row">
			${this._summary_kpi('Total Orders',   this.orders.length, '#667eea', false)}
			${this._summary_kpi('Total Value',    format_currency(total_value, null, 0), '#8b5cf6', false)}
			${this._summary_kpi('Fully Delivered', delivered, '#10b981', false)}
			${this._summary_kpi('Invoiced',        invoiced,  '#0ea5e9', false)}
		</div>

		<div class="sos-pipeline">
			${this._pipeline_html()}
		</div>

		<div class="sos-view-toggle-bar">
			<button class="sos-view-btn ${this.view_mode === 'orders' ? 'sos-view-btn-active' : ''}" data-view="orders">
				&#9776; Order List
			</button>
			<button class="sos-view-btn ${this.view_mode === 'trucks' ? 'sos-view-btn-active' : ''}" data-view="trucks">
				&#128666; Truck View
			</button>
		</div>

		<div class="sos-table-section">
			${this.view_mode === 'trucks'
				? this._render_truck_view()
				: (all.length === 0 ? this._empty_html() : this._table_html(page_orders))}
			${this.view_mode === 'orders' ? this._pagination_html(all.length) : ''}
		</div>

		${this._styles()}`;

		this.container.html(html);
		this._attach_events();
	}

	_summary_kpi(label, value, color, active) {
		return `<div class="sos-kpi" style="border-top: 4px solid ${color}">
			<div class="sos-kpi-label">${label}</div>
			<div class="sos-kpi-value" style="color:${color}">${value}</div>
		</div>`;
	}

	_pipeline_html() {
		const states = this._states();
		let html = '<div class="sos-pipe-row">';

		states.forEach((s, idx) => {
			const count   = this.orders.filter(o => o.workflow_state === s.key).length;
			const active  = this.active_state_filter === s.key;
			html += `
			<div class="sos-pipe-stage${active ? ' sos-pipe-active' : ''}"
			     data-state="${s.key}"
			     style="border-color:${s.color};${active ? `background:${s.color}15;` : ''}">
				<div class="sos-pipe-icon">${s.icon}</div>
				<div class="sos-pipe-label">${s.label}</div>
				<div class="sos-pipe-count" style="color:${s.color}">${count}</div>
			</div>
			${idx < states.length - 1 ? '<div class="sos-pipe-arrow">›</div>' : ''}`;
		});

		html += '</div>';
		if (this.active_state_filter) {
			html += `<div class="sos-pipe-clear">
				<button class="btn btn-xs btn-default sos-clear-filter">✕ Clear filter</button>
			</div>`;
		}
		return html;
	}

	_page_label_for_state(workflow_state) {
		const map = {
			'Proceed To Order':                      { label: 'Order Manager',    url: '/app/sales-order-manager' },
			'Pending Finance Approval':              { label: 'Finance Approval', url: '/app/finance-approval-man' },
			'Pending Customer Order Reconfirmation': { label: 'Order Confirmation', url: '/app/customer-order-confi' },
			'Order Confirmed':                       { label: 'Truck Assignment', url: '/app/sales-order-truck-as-v2' },
		};
		return map[workflow_state] || null;
	}

	_table_html(orders) {
		let rows = orders.map(o => {
			const state_cfg = this._states().find(s => s.key === o.workflow_state) ||
			                  { color: '#9ca3af', label: o.workflow_state || '—' };
			const del_pct  = Math.round(o.per_delivered || 0);
			const bill_pct = Math.round(o.per_billed    || 0);
			const truck    = o.custom_truck_number || '';
			const page_info = this._page_label_for_state(o.workflow_state);

			return `
			<tr class="sos-row" data-order="${o.name}">
				<td>
					<a href="/app/sales-order/${o.name}" target="_blank" class="sos-link">${o.name}</a>
				</td>
				<td>
					<div class="sos-cust-name">${frappe.utils.escape_html(o.customer_name || o.customer)}</div>
					${o.custom_phone_number
						? `<div class="sos-cust-phone"><a href="tel:${o.custom_phone_number}">${o.custom_phone_number}</a></div>`
						: ''}
				</td>
				<td>${frappe.utils.escape_html(o.sales_person || '—')}</td>
				<td>${o.custom_delivery_region
					? `<span class="sos-region-tag">${o.custom_delivery_region}</span>` : '—'}</td>
				<td class="sos-amt">${format_currency(o.grand_total)}</td>
				<td>${frappe.datetime.str_to_user(o.transaction_date)}</td>
				<td>
					<span class="sos-state-badge" style="background:${state_cfg.color}">
						${state_cfg.label}
					</span>
				</td>
				<td>
					${page_info
						? `<a href="${page_info.url}" class="sos-page-badge" style="border-color:${state_cfg.color};color:${state_cfg.color}" target="_blank">${page_info.label}</a>`
						: '<span class="sos-muted">—</span>'}
				</td>
				<td>${truck
					? `<span class="sos-truck-badge">${frappe.utils.escape_html(truck)}</span>`
					: '<span class="sos-muted">—</span>'}</td>
				<td>
					${this._progress_bar(del_pct, del_pct >= 100 ? '#10b981' : '#3b82f6')}
				</td>
				<td>
					${this._progress_bar(bill_pct, bill_pct >= 100 ? '#10b981' : '#f59e0b')}
				</td>
			</tr>`;
		}).join('');

		return `
		<div class="sos-table-wrap">
			<table class="table table-bordered sos-table">
				<thead>
					<tr>
						<th width="11%">Sales Order</th>
						<th width="14%">Customer</th>
						<th width="9%">Sales Person</th>
						<th width="8%">Region</th>
						<th width="8%">Amount</th>
						<th width="7%">Date</th>
						<th width="11%">Stage</th>
						<th width="10%">Managed In</th>
						<th width="8%">Truck</th>
						<th width="7%">Delivered</th>
						<th width="7%">Invoiced</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;
	}

	_render_truck_view() {
		// Show all orders grouped by truck, ignoring the pipeline stage filter
		// so each truck card reflects its full current load.
		let orders = this.orders;
		if (this.search_term) {
			const q = this.search_term.toLowerCase();
			orders = orders.filter(o =>
				(o.name          || '').toLowerCase().includes(q) ||
				(o.customer_name || '').toLowerCase().includes(q) ||
				(o.customer      || '').toLowerCase().includes(q)
			);
		}

		const truck_map = {};
		const no_truck  = [];
		orders.forEach(o => {
			if (o.custom_truck_number) {
				if (!truck_map[o.custom_truck_number]) truck_map[o.custom_truck_number] = [];
				truck_map[o.custom_truck_number].push(o);
			} else {
				no_truck.push(o);
			}
		});

		const truck_numbers = Object.keys(truck_map).sort();
		if (!truck_numbers.length) {
			return `<div style="padding:30px;text-align:center;color:#6b7280;">
				No orders with truck assignments in the selected date range.
			</div>`;
		}

		let html = '<div class="sos-truck-grid">';

		truck_numbers.forEach(truck_num => {
			const meta       = this.truck_meta[truck_num] || {};
			const t_orders   = truck_map[truck_num];
			const total_val  = t_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
			const total_wt   = t_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
			const capacity   = meta.capacity_kg || 0;
			const cap_pct    = capacity > 0 ? Math.min((total_wt / capacity) * 100, 100).toFixed(0) : null;

			const order_rows = t_orders.map(o => {
				const state_cfg = this._states().find(s => s.key === o.workflow_state) ||
				                  { color: '#9ca3af', label: o.workflow_state || '—' };
				const del_pct   = Math.round(o.per_delivered || 0);
				return `
				<div class="sos-tv-order">
					<div class="sos-tv-order-main">
						<a href="/app/sales-order/${o.name}" target="_blank" class="sos-link">${frappe.utils.escape_html(o.name)}</a>
						<span class="sos-tv-cust">${frappe.utils.escape_html(o.customer_name || o.customer)}</span>
					</div>
					<div class="sos-tv-order-right">
						<span class="sos-state-badge" style="background:${state_cfg.color};font-size:10px;padding:2px 7px;">${state_cfg.label}</span>
						${del_pct >= 100
							? '<span class="sos-tv-done">&#10003; Delivered</span>'
							: `<span class="sos-tv-pct">${del_pct}% del.</span>`}
					</div>
				</div>`;
			}).join('');

			html += `
			<div class="sos-truck-card">
				<div class="sos-tc-head">
					<div>
						<span class="sos-tc-num">&#128666; ${frappe.utils.escape_html(truck_num)}</span>
						${meta.driver_name ? `<span class="sos-tc-driver">${frappe.utils.escape_html(meta.driver_name)}</span>` : ''}
					</div>
					<button class="btn btn-xs sos-tc-dl-btn" data-truck="${frappe.utils.escape_html(truck_num)}" title="Download truck report">&#8659;</button>
				</div>
				<div class="sos-tc-stats">
					<span>${t_orders.length} order${t_orders.length !== 1 ? 's' : ''}</span>
					<span class="sos-tc-val">${format_currency(total_val, null, 0)}</span>
					<span class="sos-tc-wt">${total_wt.toFixed(0)} kg</span>
				</div>
				${cap_pct !== null ? `
				<div class="sos-tc-cap-bar">
					<div class="sos-tc-cap-fill" style="width:${cap_pct}%;background:${cap_pct > 90 ? '#ef4444' : '#10b981'}"></div>
				</div>
				<div class="sos-tc-cap-label">${cap_pct}% of ${capacity.toLocaleString()} kg</div>
				` : ''}
				<div class="sos-tc-orders">${order_rows}</div>
			</div>`;
		});

		html += '</div>';

		if (no_truck.length) {
			html += `<div class="sos-tv-unassigned">
				${no_truck.length} order${no_truck.length !== 1 ? 's' : ''} without truck assignment
			</div>`;
		}

		if (this.closed_trucks.length) {
			html += `<div class="sos-closed-section">
				<div class="sos-closed-header">Dispatched Trucks <span class="sos-closed-count">${this.closed_trucks.length}</span></div>
				<div class="sos-truck-grid">`;

			this.closed_trucks.forEach((ct, idx) => {
				const closed_label = ct.closed_at
					? frappe.datetime.str_to_user(ct.closed_at.split(' ')[0]) + ' ' + (ct.closed_at.split(' ')[1] || '').slice(0, 5)
					: '—';
				const order_rows = (ct.orders || []).map(o => `
					<div class="sos-tv-order">
						<div class="sos-tv-order-main">
							<a href="/app/sales-order/${o.name}" target="_blank" class="sos-link">${frappe.utils.escape_html(o.name)}</a>
							<span class="sos-tv-cust">${frappe.utils.escape_html(o.customer_name || '')}</span>
						</div>
						${o.delivery_region ? `<span style="font-size:10px;color:#94a3b8;">${frappe.utils.escape_html(o.delivery_region)}</span>` : ''}
					</div>`).join('');

				html += `<div class="sos-truck-card sos-closed-card">
					<div class="sos-tc-head" style="background:#475569;">
						<div>
							<span class="sos-tc-num">&#10003; ${frappe.utils.escape_html(ct.truck_number)}</span>
							${ct.driver_name ? `<span class="sos-tc-driver">${frappe.utils.escape_html(ct.driver_name)}</span>` : ''}
						</div>
						<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
							<span style="font-size:10px;color:#94a3b8;">Dispatched ${frappe.utils.escape_html(closed_label)}</span>
							<button class="btn btn-xs sos-tc-dl-btn sos-dl-closed-btn" data-idx="${idx}" title="Download report">&#8659;</button>
						</div>
					</div>
					<div class="sos-tc-stats">
						<span>${ct.order_count} order${ct.order_count !== 1 ? 's' : ''}</span>
						<span class="sos-tc-val">${format_currency(ct.total_value || 0, null, 0)}</span>
						<span class="sos-tc-wt">${(ct.total_weight || 0).toFixed(0)} kg</span>
					</div>
					${(ct.orders || []).length ? `<div class="sos-tc-orders">${order_rows}</div>` : ''}
				</div>`;
			});

			html += '</div></div>';
		}

		return html;
	}

	_progress_bar(pct, color) {
		return `<div class="sos-prog-wrap" title="${pct}%">
			<div class="sos-prog-fill" style="width:${Math.min(pct,100)}%;background:${color}"></div>
			<span class="sos-prog-label">${pct}%</span>
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

	_empty_html() {
		return `<div class="alert alert-info" style="margin-top:16px;">
			<strong>No orders found</strong><br>
			${this.orders.length > 0
				? 'No orders match the selected stage filter.'
				: 'No sales orders in the selected date range.'}
		</div>`;
	}

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
			self.active_state_filter = null; self.current_page = 1; self.load_data();
		});
	}

	_loading_html() {
		return `<div style="text-align:center;padding:60px;color:#6b7280;">
			<i class="fa fa-spinner fa-spin fa-2x"></i><br><br>Loading orders…
		</div>`;
	}

	// ── Events ────────────────────────────────────────────────────────────────

	_attach_events() {
		this.container.find('.sos-view-btn').on('click', (e) => {
			const view = $(e.currentTarget).data('view');
			if (this.view_mode !== view) {
				this.view_mode = view;
				this.render();
			}
		});

		this.container.find('.sos-pipe-stage').on('click', (e) => {
			const state = $(e.currentTarget).data('state');
			this.active_state_filter = this.active_state_filter === state ? null : state;
			this.current_page = 1;
			this.render();
		});

		this.container.find('.sos-clear-filter').on('click', () => {
			this.active_state_filter = null;
			this.current_page = 1;
			this.render();
		});

		this.container.find('.sos-pg-prev').on('click', () => {
			if (this.current_page > 1) { this.current_page--; this.render(); }
		});
		this.container.find('.sos-pg-next').on('click', () => {
			const tp = Math.ceil(this._get_filtered_orders().length / this.page_size);
			if (this.current_page < tp) { this.current_page++; this.render(); }
		});

		this.container.find('.sos-tc-dl-btn:not(.sos-dl-closed-btn)').on('click', (e) => {
			this._download_truck_status($(e.currentTarget).data('truck'));
		});

		this.container.find('.sos-dl-closed-btn').on('click', (e) => {
			const ct = this.closed_trucks[parseInt($(e.currentTarget).data('idx'), 10)];
			if (ct) this._download_closed_truck(ct);
		});
	}

	_download_closed_truck(ct) {
		const today = frappe.datetime.now_date();
		const rows  = (ct.orders || []).map(o => `<tr>
			<td>${frappe.utils.escape_html(o.name)}</td>
			<td>${frappe.utils.escape_html(o.customer_name || '')}</td>
			<td>${frappe.utils.escape_html(o.delivery_region || '—')}</td>
		</tr>`).join('');

		const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
			xmlns:x="urn:schemas-microsoft-com:office:excel"
			xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<style>
	table{border-collapse:collapse}
	th,td{border:1px solid #ddd;padding:8px;font-family:sans-serif;font-size:12px}
	th{background:#475569;color:#fff;font-weight:bold}
</style></head><body>
<h2 style="font-family:sans-serif">DISPATCHED TRUCK — ${frappe.utils.escape_html(ct.truck_number)}</h2>
<table style="margin-bottom:16px;border:none;font-family:sans-serif"><tr style="border:none">
	<td style="border:none;font-weight:bold">Truck:</td><td style="border:none">${frappe.utils.escape_html(ct.truck_number)}</td>
	${ct.driver_name ? `<td style="border:none;font-weight:bold;padding-left:20px">Driver:</td><td style="border:none">${frappe.utils.escape_html(ct.driver_name)}</td>` : ''}
	<td style="border:none;font-weight:bold;padding-left:20px">Dispatched:</td><td style="border:none">${frappe.utils.escape_html(ct.closed_at || '—')}</td>
	<td style="border:none;font-weight:bold;padding-left:20px">Orders:</td><td style="border:none">${ct.order_count}</td>
	<td style="border:none;font-weight:bold;padding-left:20px">Weight:</td><td style="border:none">${(ct.total_weight || 0).toFixed(2)} kg</td>
	<td style="border:none;font-weight:bold;padding-left:20px">Value:</td><td style="border:none">${(ct.total_value || 0).toFixed(2)}</td>
</tr></table>
<table>
	<thead><tr><th>Order</th><th>Customer</th><th>Region</th></tr></thead>
	<tbody>${rows}</tbody>
</table>
</body></html>`;

		const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
		const a    = document.createElement('a');
		a.href     = URL.createObjectURL(blob);
		a.download = `Truck_${ct.truck_number}_Dispatched_${today}.xls`;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		frappe.show_alert({ message: __('Downloaded report for dispatched truck {0}', [ct.truck_number]), indicator: 'green' });
	}

	_download_truck_status(truck_num) {
		const meta        = this.truck_meta[truck_num] || {};
		const t_orders    = this.orders.filter(o => o.custom_truck_number === truck_num);
		const total_wt    = t_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
		const total_val   = t_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
		const today       = frappe.datetime.now_date();

		const state_label = (state) => {
			const map = {
				'Pending Finance Approval':              'Finance Approval',
				'Pending Customer Order Reconfirmation': 'Pending Confirm',
				'Order Confirmed':                       'Confirmed',
			};
			return map[state] || state || '—';
		};

		const sorted = [...t_orders].sort((a, b) =>
			(a.custom_delivery_region || '').localeCompare(b.custom_delivery_region || '')
		);

		const rows = sorted.map(o => {
			const del_pct = Math.round(o.per_delivered || 0);
			return `<tr>
				<td>${frappe.utils.escape_html(o.name)}</td>
				<td>${frappe.utils.escape_html(o.customer_name || o.customer)}</td>
				<td>${frappe.utils.escape_html(o.custom_delivery_region || '—')}</td>
				<td style="text-align:right">${(o.total_net_weight || 0).toFixed(2)}</td>
				<td style="text-align:right">${(o.grand_total || 0).toFixed(2)}</td>
				<td>${state_label(o.workflow_state)}</td>
				<td style="text-align:center">${del_pct}%</td>
				<td style="text-align:center">${del_pct >= 100 ? 'Yes' : 'No'}</td>
			</tr>`;
		}).join('');

		const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
			xmlns:x="urn:schemas-microsoft-com:office:excel"
			xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<style>
	table{border-collapse:collapse}
	th,td{border:1px solid #ddd;padding:8px;text-align:left;font-family:sans-serif;font-size:12px}
	th{background:#1e293b;color:#fff;font-weight:bold}
	tfoot td{background:#f1f5f9;font-weight:bold}
</style>
</head><body>
<h2 style="font-family:sans-serif">TRUCK STATUS REPORT</h2>
<table style="margin-bottom:16px;border:none;font-family:sans-serif"><tr style="border:none">
	<td style="border:none;font-weight:bold">Truck:</td><td style="border:none">${frappe.utils.escape_html(truck_num)}</td>
	${meta.driver_name ? `<td style="border:none;font-weight:bold;padding-left:20px">Driver:</td><td style="border:none">${frappe.utils.escape_html(meta.driver_name)}</td>` : ''}
	<td style="border:none;font-weight:bold;padding-left:20px">Date:</td><td style="border:none">${today}</td>
	<td style="border:none;font-weight:bold;padding-left:20px">Orders:</td><td style="border:none">${t_orders.length}</td>
	<td style="border:none;font-weight:bold;padding-left:20px">Weight:</td><td style="border:none">${total_wt.toFixed(2)} kg</td>
	<td style="border:none;font-weight:bold;padding-left:20px">Value:</td><td style="border:none">${total_val.toFixed(2)}</td>
</tr></table>
<table>
	<thead><tr>
		<th>Order</th><th>Customer</th><th>Region</th>
		<th>Weight (kg)</th><th>Value</th><th>Status</th>
		<th>Delivered %</th><th>Fully Delivered</th>
	</tr></thead>
	<tbody>${rows}</tbody>
	<tfoot><tr>
		<td colspan="3" style="text-align:right">TOTALS</td>
		<td style="text-align:right">${total_wt.toFixed(2)}</td>
		<td style="text-align:right">${total_val.toFixed(2)}</td>
		<td colspan="3"></td>
	</tr></tfoot>
</table>
</body></html>`;

		const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
		const a    = document.createElement('a');
		a.href     = URL.createObjectURL(blob);
		a.download = `Truck_${truck_num}_Status_${today}.xls`;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		frappe.show_alert({ message: __('Downloaded status report for {0}', [truck_num]), indicator: 'green' });
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	_styles() {
		return `<style>
		.sos-container { margin-top: 16px; }

		/* Search bar */
		.sos-search-row {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 14px;
		}
		.sos-search-input {
			max-width: 340px;
			height: 34px;
			font-size: 13px;
			border-radius: 6px;
		}
		.sos-search-count {
			font-size: 12px;
			color: #6b7280;
			white-space: nowrap;
		}

		/* Page badge */
		.sos-page-badge {
			display: inline-block;
			padding: 2px 8px;
			border: 1px solid currentColor;
			border-radius: 4px;
			font-size: 11px;
			font-weight: 600;
			text-decoration: none;
			white-space: nowrap;
			transition: opacity .15s;
		}
		.sos-page-badge:hover { opacity: .75; text-decoration: none; }

		/* Summary KPIs */
		.sos-summary-row {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
			gap: 14px;
			margin-bottom: 20px;
		}
		.sos-kpi {
			background: #fff;
			border-radius: 8px;
			padding: 14px 18px;
			box-shadow: 0 1px 6px rgba(0,0,0,.07);
		}
		.sos-kpi-label { font-size: 11px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
		.sos-kpi-value { font-size: 20px; font-weight: 700; }

		/* Pipeline */
		.sos-pipeline {
			background: #fff;
			border-radius: 8px;
			padding: 16px 20px;
			box-shadow: 0 1px 6px rgba(0,0,0,.07);
			margin-bottom: 20px;
		}
		.sos-pipe-row {
			display: flex;
			align-items: center;
			gap: 6px;
			flex-wrap: wrap;
		}
		.sos-pipe-stage {
			flex: 1;
			min-width: 120px;
			border: 2px solid #e5e7eb;
			border-radius: 8px;
			padding: 12px 10px;
			text-align: center;
			cursor: pointer;
			transition: all .2s;
		}
		.sos-pipe-stage:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,.1); }
		.sos-pipe-active { box-shadow: 0 4px 14px rgba(0,0,0,.12); }
		.sos-pipe-icon { font-size: 20px; margin-bottom: 4px; }
		.sos-pipe-label { font-size: 11px; color: #374151; font-weight: 600; margin-bottom: 4px; }
		.sos-pipe-count { font-size: 22px; font-weight: 700; }
		.sos-pipe-arrow { font-size: 22px; color: #d1d5db; padding: 0 2px; }
		.sos-pipe-clear { margin-top: 10px; text-align: center; }

		/* Table */
		.sos-table-section { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 6px rgba(0,0,0,.07); }
		.sos-table-wrap { overflow-x: auto; }
		.sos-table { margin-bottom: 0 !important; }
		.sos-table thead { background: #1e293b; }
		.sos-table thead th {
			color: #fff !important;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: .4px;
			padding: 12px 10px !important;
			border: none !important;
			white-space: nowrap;
		}
		.sos-row td { padding: 11px 10px !important; vertical-align: middle !important; font-size: 13px; }
		.sos-row:hover { background: #f8fafc !important; }
		.sos-link { color: #3b82f6; font-weight: 600; text-decoration: none; }
		.sos-link:hover { text-decoration: underline; }
		.sos-amt { text-align: right; font-family: monospace; font-weight: 600; }
		.sos-muted { color: #9ca3af; }
		.sos-cust-name { font-weight: 600; color: #111827; }
		.sos-cust-phone { font-size: 11px; color: #6b7280; margin-top: 2px; }
		.sos-cust-phone a { color: #0891b2; text-decoration: none; }
		.sos-region-tag {
			display: inline-block;
			padding: 2px 8px;
			background: #f1f5f9;
			border-radius: 4px;
			font-size: 11px;
			color: #475569;
			font-weight: 500;
		}
		.sos-state-badge {
			display: inline-block;
			padding: 3px 10px;
			border-radius: 12px;
			font-size: 11px;
			font-weight: 600;
			color: #fff;
			white-space: nowrap;
		}
		.sos-truck-badge {
			display: inline-block;
			padding: 2px 8px;
			background: #1e293b;
			color: #fff;
			border-radius: 4px;
			font-size: 11px;
			font-weight: 600;
		}
		/* Progress bars */
		.sos-prog-wrap {
			position: relative;
			background: #e5e7eb;
			border-radius: 3px;
			height: 16px;
			overflow: hidden;
			min-width: 50px;
		}
		.sos-prog-fill {
			position: absolute;
			left: 0; top: 0; bottom: 0;
			border-radius: 3px;
			transition: width .3s;
		}
		.sos-prog-label {
			position: absolute;
			left: 0; right: 0;
			text-align: center;
			font-size: 10px;
			font-weight: 700;
			color: #fff;
			line-height: 16px;
			text-shadow: 0 0 3px rgba(0,0,0,.4);
		}

		/* View toggle bar */
		.sos-view-toggle-bar {
			display: flex;
			gap: 6px;
			margin-bottom: 12px;
		}
		.sos-view-btn {
			padding: 5px 16px;
			border: 1px solid #d1d5db;
			border-radius: 6px;
			background: #fff;
			color: #374151;
			font-size: 12px;
			font-weight: 600;
			cursor: pointer;
			transition: all .15s;
		}
		.sos-view-btn:hover { background: #f3f4f6; }
		.sos-view-btn-active { background: #1e293b; color: #fff; border-color: #1e293b; }

		/* Truck grid */
		.sos-truck-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
			gap: 16px;
			padding: 16px;
		}
		.sos-truck-card {
			border: 1px solid #e5e7eb;
			border-radius: 8px;
			overflow: hidden;
		}
		.sos-tc-head {
			background: #1e293b;
			color: #fff;
			padding: 10px 14px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
		}
		.sos-tc-num { font-weight: 700; font-size: 13px; }
		.sos-tc-driver { font-size: 11px; color: #94a3b8; margin-top: 2px; }
		.sos-tc-dl-btn {
			background: rgba(255,255,255,0.12);
			border: 1px solid rgba(255,255,255,0.25);
			color: #fff;
			border-radius: 4px;
			padding: 2px 8px;
			font-size: 13px;
			flex-shrink: 0;
		}
		.sos-tc-dl-btn:hover { background: rgba(255,255,255,0.22); color: #fff; }
		.sos-tc-stats {
			padding: 7px 14px;
			background: #f8fafc;
			border-bottom: 1px solid #e5e7eb;
			display: flex;
			gap: 14px;
			font-size: 11px;
			color: #6b7280;
		}
		.sos-tc-val { font-weight: 600; color: #374151; }
		.sos-tc-wt  { color: #6b7280; }
		.sos-tc-cap-bar {
			margin: 0 14px 3px;
			background: #e5e7eb;
			border-radius: 3px;
			height: 5px;
			overflow: hidden;
		}
		.sos-tc-cap-fill { height: 100%; border-radius: 3px; transition: width .3s; }
		.sos-tc-cap-label { font-size: 10px; color: #9ca3af; padding: 0 14px 6px; }
		.sos-tc-orders { }
		.sos-tv-order {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			padding: 7px 14px;
			border-bottom: 1px solid #f1f5f9;
			gap: 8px;
		}
		.sos-tv-order:last-child { border-bottom: none; }
		.sos-tv-order-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
		.sos-tv-cust { font-size: 11px; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.sos-tv-order-right { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex-shrink: 0; }
		.sos-tv-done { font-size: 10px; color: #10b981; font-weight: 600; }
		.sos-tv-pct { font-size: 10px; color: #9ca3af; }
		.sos-tv-unassigned {
			text-align: center;
			padding: 10px 16px 16px;
			font-size: 12px;
			color: #9ca3af;
		}
		.sos-closed-section { margin-top: 28px; }
		.sos-closed-header {
			font-size: 13px;
			font-weight: 700;
			color: #475569;
			padding: 6px 0 12px;
			display: flex;
			align-items: center;
			gap: 8px;
			border-top: 2px solid #e2e8f0;
		}
		.sos-closed-count {
			background: #475569;
			color: #fff;
			border-radius: 10px;
			padding: 1px 8px;
			font-size: 11px;
		}
		.sos-closed-card { opacity: 0.85; }
		.sos-closed-card:hover { opacity: 1; }

		/* Pagination */
		.sos-pg-bar {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 14px;
			padding: 12px 16px;
			border-top: 1px solid #e5e7eb;
			background: #f9fafb;
		}
		.sos-pg-info { font-size: 13px; color: #6b7280; }
		.sos-pg-bar .btn { min-width: 70px; }
		</style>`;
	}
}
