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
			change: () => { this.active_state_filter = null; this.current_page = 1; this.load_data(); }
		});
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

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_status.sales_order_status.get_daily_orders',
			args: {
				from_date,
				to_date,
				sales_person:    this.page.fields_dict.sales_person.get_value()    || null,
				delivery_region: this.page.fields_dict.delivery_region.get_value() || null,
			},
			callback: (r) => {
				this.orders = r.message || [];
				this.current_page = 1;
				this.render();
			},
			error: () => {
				this.orders = [];
				this.render();
			}
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
		const on_hold     = this.orders.filter(o => o.custom_on_hold).length;
		const delivered   = this.orders.filter(o => (o.per_delivered || 0) >= 100).length;
		const invoiced    = this.orders.filter(o => (o.per_billed    || 0) >= 100).length;

		let html = `
		<div class="sos-summary-row">
			${this._summary_kpi('Total Orders',   this.orders.length, '#667eea', false)}
			${this._summary_kpi('Total Value',    format_currency(total_value, null, 0), '#8b5cf6', false)}
			${this._summary_kpi('On Hold',        on_hold,   on_hold > 0 ? '#ef4444' : '#10b981', false)}
			${this._summary_kpi('Fully Delivered', delivered, '#10b981', false)}
			${this._summary_kpi('Invoiced',        invoiced,  '#0ea5e9', false)}
		</div>

		<div class="sos-pipeline">
			${this._pipeline_html()}
		</div>

		<div class="sos-table-section">
			${all.length === 0 ? this._empty_html() : this._table_html(page_orders)}
			${this._pagination_html(all.length)}
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
			'Order Confirmed':                       { label: 'Truck Assignment', url: '/app/sales-order-truck-as' },
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
			const hold_badge = o.custom_on_hold
				? '<span class="sos-hold-badge">ON HOLD</span>' : '';
			const page_info = this._page_label_for_state(o.workflow_state);

			return `
			<tr class="sos-row" data-order="${o.name}">
				<td>
					<a href="/app/sales-order/${o.name}" target="_blank" class="sos-link">${o.name}</a>
					${hold_badge}
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

	_loading_html() {
		return `<div style="text-align:center;padding:60px;color:#6b7280;">
			<i class="fa fa-spinner fa-spin fa-2x"></i><br><br>Loading orders…
		</div>`;
	}

	// ── Events ────────────────────────────────────────────────────────────────

	_attach_events() {
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
		.sos-hold-badge {
			display: inline-block;
			margin-left: 6px;
			padding: 1px 6px;
			background: #ef4444;
			color: #fff;
			border-radius: 3px;
			font-size: 10px;
			font-weight: 700;
			vertical-align: middle;
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
