frappe.pages['sales-order-manager'].on_page_load = function (wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Sales Order Manager',
		single_column: true,
	});
	new SalesOrderManager(page);
};

class SalesOrderManager {
	constructor(page) {
		this.page = page;
		this.orders = [];
		this.selected = new Set();
		this.expanded = new Set();
		this.item_cache = {};
		this.setup_page();
		this.load_data();
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	setup_page() {
		const today = frappe.datetime.get_today();

		this.page.add_field({
			label: 'From Date', fieldtype: 'Date', fieldname: 'from_date',
			default: frappe.datetime.add_days(today, -7),
			change: () => this.render(),
		});
		this.page.add_field({
			label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
			default: today,
			change: () => this.render(),
		});
		this.page.add_field({
			label: 'Region', fieldtype: 'Link', fieldname: 'delivery_region',
			options: 'Territory',
			change: () => this.render(),
		});
		this.page.add_field({
			label: 'Sales Person', fieldtype: 'Link', fieldname: 'sales_person',
			options: 'Sales Person',
			change: () => this.load_data(),
		});

		this.page.set_primary_action(
			'Send to Finance',
			() => this.submit_selected(),
			'octicon octicon-arrow-right'
		);
		this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');

		this.$wrap = $('<div class="som-wrap"></div>').appendTo(this.page.main);
	}

	// ── Data ──────────────────────────────────────────────────────────────────

	load_data() {
		this.$wrap.html(this._spinner());

		const sp = this.page.fields_dict.sales_person.get_value();
		const filters = [
			['Sales Order', 'docstatus', '=', 0],
		];
		if (sp) filters.push(['Sales Team', 'sales_person', '=', sp]);

		frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Sales Order',
				fields: [
					'name', 'customer', 'customer_name', 'transaction_date',
					'grand_total', 'custom_delivery_region', 'owner',
					'workflow_state', 'custom_on_hold',
				],
				filters,
				order_by: 'transaction_date desc',
				limit_page_length: 500,
			},
			callback: (r) => {
				const all = r.message || [];
				this.orders = all.filter(o =>
					!o.workflow_state ||
					o.workflow_state === '' ||
					o.workflow_state === 'Proceed To Order'
				);
				this.render();
			},
		});
	}

	filtered_orders() {
		const from   = this.page.fields_dict.from_date.get_value();
		const to     = this.page.fields_dict.to_date.get_value();
		const region = this.page.fields_dict.delivery_region.get_value();
		return this.orders.filter(o => {
			if (from   && o.transaction_date < from)               return false;
			if (to     && o.transaction_date > to)                 return false;
			if (region && o.custom_delivery_region !== region)     return false;
			return true;
		});
	}

	// ── Render ────────────────────────────────────────────────────────────────

	render() {
		const orders = this.filtered_orders();

		if (!orders.length) {
			this.$wrap.html(`
				<div class="som-empty">
					<div class="som-empty-icon">📋</div>
					<div class="som-empty-title">No orders ready to submit</div>
					<div class="som-empty-sub">
						${this.orders.length
							? 'All orders are filtered out — try clearing the filters.'
							: 'No draft sales orders found in this date range.'}
					</div>
				</div>
				${this._styles()}`);
			return;
		}

		const total_val  = orders.reduce((s, o) => s + o.grand_total, 0);
		const on_hold    = orders.filter(o => o.custom_on_hold).length;
		const selectable = orders.filter(o => !o.custom_on_hold).length;

		let html = `
		${this._styles()}
		<div class="som-kpi-row">
			${this._kpi('Orders Ready', selectable,                   '#3b82f6', '📦')}
			${this._kpi('On Hold',      on_hold,                      '#f59e0b', '⏸')}
			${this._kpi('Total Value',  format_currency(total_val),   '#10b981', '💰')}
			${this._kpi('Selected',     this.selected.size,           '#8b5cf6', '✓')}
		</div>

		<div class="som-card">
			<div class="som-card-header">
				<label class="som-select-all-label">
					<input type="checkbox" class="som-select-all" id="som-select-all">
					<span>Select all eligible</span>
				</label>
				<span class="som-count-label">
					Showing ${orders.length} order${orders.length !== 1 ? 's' : ''}
					${this.orders.length !== orders.length ? ` (${this.orders.length} total)` : ''}
				</span>
			</div>

			<table class="som-table">
				<thead>
					<tr>
						<th class="som-th-chk"></th>
						<th class="som-th-exp"></th>
						<th>Sales Order</th>
						<th>Customer</th>
						<th>Date</th>
						<th>Region</th>
						<th>Sales Person</th>
						<th class="som-th-r">Amount</th>
						<th>Status</th>
						<th class="som-th-act">Hold</th>
					</tr>
				</thead>
				<tbody>`;

		orders.forEach(o => {
			const held     = !!o.custom_on_hold;
			const checked  = this.selected.has(o.name);
			const expanded = this.expanded.has(o.name);

			html += `
				<tr class="som-row ${held ? 'som-row-held' : ''} ${checked ? 'som-row-selected' : ''}"
				    data-order="${o.name}">
					<td class="som-td-chk">
						<input type="checkbox" class="som-chk" data-order="${o.name}"
						       ${checked ? 'checked' : ''} ${held ? 'disabled' : ''}>
					</td>
					<td class="som-td-exp">
						<button class="som-expand-btn" data-order="${o.name}"
						        title="${expanded ? 'Collapse' : 'View items'}">
							${expanded ? '▾' : '▸'}
						</button>
					</td>
					<td>
						<a class="som-link" href="/app/sales-order/${o.name}" target="_blank">
							${o.name}
						</a>
					</td>
					<td class="som-customer">${o.customer_name || o.customer}</td>
					<td class="som-date">${frappe.datetime.str_to_user(o.transaction_date)}</td>
					<td>${o.custom_delivery_region
						? `<span class="som-region-tag">${o.custom_delivery_region}</span>`
						: '<span class="som-na">—</span>'}
					</td>
					<td class="som-owner">${frappe.user.full_name(o.owner) || o.owner}</td>
					<td class="som-th-r som-amount">${format_currency(o.grand_total)}</td>
					<td>
						${held
							? '<span class="som-badge som-badge-held">On Hold</span>'
							: '<span class="som-badge som-badge-ready">Ready</span>'}
					</td>
					<td class="som-th-act">
						<button class="som-hold-btn ${held ? 'som-hold-btn-release' : 'som-hold-btn-hold'}"
						        data-order="${o.name}" data-held="${held ? 1 : 0}"
						        title="${held ? 'Release hold' : 'Put on hold'}">
							${held ? '▶' : '⏸'}
						</button>
					</td>
				</tr>`;

			if (expanded) {
				html += `
				<tr class="som-items-row" data-order="${o.name}">
					<td colspan="10">
						<div class="som-items-wrap" id="som-items-${o.name}">
							${this._render_items(o.name)}
						</div>
					</td>
				</tr>`;
			}
		});

		html += `</tbody></table></div>`;
		this.$wrap.html(html);
		this._attach_events();
	}

	_render_items(order_name) {
		const items = this.item_cache[order_name];
		if (!items) {
			this._fetch_items(order_name);
			return `<div class="som-items-loading"><i class="fa fa-spinner fa-spin"></i> Loading items…</div>`;
		}
		if (!items.length) return `<div class="som-items-loading">No items found.</div>`;

		let html = `<table class="som-items-table">
			<thead><tr>
				<th>Item Code</th><th>Description</th>
				<th class="som-th-r">Qty</th><th>UOM</th>
				<th class="som-th-r">Rate</th><th class="som-th-r">Amount</th>
			</tr></thead><tbody>`;

		items.forEach(item => {
			html += `<tr>
				<td><strong>${item.item_code}</strong></td>
				<td class="som-item-name">${item.item_name || ''}</td>
				<td class="som-th-r">${item.qty}</td>
				<td>${item.uom || ''}</td>
				<td class="som-th-r">${format_currency(item.rate)}</td>
				<td class="som-th-r"><strong>${format_currency(item.amount)}</strong></td>
			</tr>`;
		});

		html += `</tbody></table>`;
		return html;
	}

	_fetch_items(order_name) {
		frappe.call({
			method: 'frappe.client.get',
			args: { doctype: 'Sales Order', name: order_name },
			callback: (r) => {
				if (r.message) {
					this.item_cache[order_name] = r.message.items || [];
					const $wrap = $(`#som-items-${order_name}`);
					if ($wrap.length) $wrap.html(this._render_items(order_name));
				}
			},
		});
	}

	// ── Events ────────────────────────────────────────────────────────────────

	_attach_events() {
		const self = this;

		// Select all
		this.$wrap.find('#som-select-all').on('change', function () {
			const checked = $(this).is(':checked');
			self.$wrap.find('.som-chk:not(:disabled)').prop('checked', checked);
			self.orders.forEach(o => {
				if (!o.custom_on_hold) {
					checked ? self.selected.add(o.name) : self.selected.delete(o.name);
				}
			});
			self.render();
		});

		// Individual checkbox — update in-place without full re-render
		this.$wrap.find('.som-chk').on('change', function () {
			const name = $(this).data('order');
			$(this).is(':checked') ? self.selected.add(name) : self.selected.delete(name);
			// update KPI count in place
			self.$wrap.find('.som-kpi-row .som-kpi-val').eq(3).text(self.selected.size);
			$(this).closest('tr').toggleClass('som-row-selected', $(this).is(':checked'));
		});

		// Expand / collapse row
		this.$wrap.find('.som-expand-btn').on('click', function () {
			const name = $(this).data('order');
			if (self.expanded.has(name)) {
				self.expanded.delete(name);
			} else {
				self.expanded.add(name);
			}
			self.render();
		});

		// Hold toggle
		this.$wrap.find('.som-hold-btn').on('click', function () {
			const name   = $(this).data('order');
			const is_held = parseInt($(this).data('held')) === 1;
			self._toggle_hold(name, !is_held);
		});
	}

	_toggle_hold(order_name, hold) {
		frappe.call({
			method: 'frappe.client.set_value',
			args: { doctype: 'Sales Order', name: order_name, fieldname: 'custom_on_hold', value: hold ? 1 : 0 },
			callback: (r) => {
				if (r.message) {
					const o = this.orders.find(x => x.name === order_name);
					if (o) o.custom_on_hold = hold ? 1 : 0;
					if (hold) this.selected.delete(order_name);
					frappe.show_alert({
						message: __(hold ? '{0} put on hold' : '{0} hold released', [order_name]),
						indicator: hold ? 'orange' : 'green',
					});
					this.render();
				}
			},
		});
	}

	// ── Submit ────────────────────────────────────────────────────────────────

	submit_selected() {
		const list = Array.from(this.selected);
		if (!list.length) { frappe.msgprint(__('Select at least one order.')); return; }

		frappe.confirm(
			__('Send {0} order(s) to Finance for approval?', [list.length]),
			() => this._process(list)
		);
	}

	_process(list) {
		let done = 0, errors = [];

		frappe.show_alert({ message: __('Submitting…'), indicator: 'blue' });

		const next = () => {
			if (done >= list.length) {
				if (errors.length) {
					frappe.msgprint({ title: __('Done with errors'), message: errors.join('<br>'), indicator: 'orange' });
				} else {
					frappe.show_alert({
						message: __('✓ {0} orders sent to Finance', [list.length]),
						indicator: 'green',
					});
				}
				this.selected.clear();
				this.load_data();
				return;
			}
			const name = list[done];
			frappe.call({
				method: 'frappe.client.set_value',
				args: { doctype: 'Sales Order', name, fieldname: 'workflow_state', value: 'Pending Finance Approval' },
				callback: (r) => {
					frappe.show_alert({ message: name, indicator: r.message ? 'green' : 'orange' });
					if (!r.message) errors.push(name);
					done++; next();
				},
				error: () => { errors.push(name); done++; next(); },
			});
		};
		next();
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	_kpi(label, value, color, icon) {
		return `<div class="som-kpi">
			<div class="som-kpi-icon" style="color:${color}">${icon}</div>
			<div class="som-kpi-body">
				<div class="som-kpi-label">${label}</div>
				<div class="som-kpi-val" style="color:${color}">${value}</div>
			</div>
		</div>`;
	}

	_spinner() {
		return `<div class="som-spinner"><i class="fa fa-spinner fa-spin fa-2x"></i><p>Loading orders…</p></div>`;
	}

	_styles() {
		return `<style>
		.som-wrap { margin-top: 16px; }

		/* Spinner / empty */
		.som-spinner { text-align:center; padding:60px; color:#9ca3af; }
		.som-empty { text-align:center; padding:80px 20px; }
		.som-empty-icon { font-size:48px; margin-bottom:16px; }
		.som-empty-title { font-size:20px; font-weight:700; color:#1e293b; margin-bottom:8px; }
		.som-empty-sub { color:#6b7280; font-size:14px; }

		/* KPI row */
		.som-kpi-row {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
			gap: 12px;
			margin-bottom: 20px;
		}
		.som-kpi {
			background: #fff;
			border-radius: 10px;
			padding: 16px 18px;
			display: flex;
			align-items: center;
			gap: 14px;
			box-shadow: 0 1px 4px rgba(0,0,0,.06);
			border: 1px solid #f1f5f9;
		}
		.som-kpi-icon { font-size: 26px; line-height: 1; }
		.som-kpi-label { font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .5px; }
		.som-kpi-val { font-size: 20px; font-weight: 700; margin-top: 2px; }

		/* Card */
		.som-card {
			background: #fff;
			border-radius: 10px;
			box-shadow: 0 1px 4px rgba(0,0,0,.06);
			border: 1px solid #f1f5f9;
			overflow: hidden;
		}
		.som-card-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 12px 16px;
			background: #f8fafc;
			border-bottom: 1px solid #e2e8f0;
		}
		.som-select-all-label {
			display: flex;
			align-items: center;
			gap: 8px;
			font-weight: 600;
			font-size: 13px;
			color: #374151;
			cursor: pointer;
			margin: 0;
		}
		.som-select-all-label input { width:16px; height:16px; accent-color:#3b82f6; cursor:pointer; }
		.som-count-label { font-size: 12px; color: #94a3b8; }

		/* Table */
		.som-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 13px;
		}
		.som-table thead th {
			background: #1e293b;
			color: #e2e8f0;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: .4px;
			padding: 11px 12px;
			white-space: nowrap;
			border: none;
		}
		.som-th-chk, .som-td-chk { width: 36px; text-align: center; }
		.som-th-exp, .som-td-exp { width: 36px; text-align: center; }
		.som-th-act { width: 56px; text-align: center; }
		.som-th-r  { text-align: right !important; }

		.som-row td {
			padding: 11px 12px;
			border-bottom: 1px solid #f1f5f9;
			vertical-align: middle;
			color: #334155;
		}
		.som-row:last-child td { border-bottom: none; }
		.som-row:hover td { background: #f8fafc; }
		.som-row-selected td { background: #eff6ff !important; }
		.som-row-held td { background: #fffbeb; opacity: .85; }

		.som-chk { width:16px; height:16px; accent-color:#3b82f6; cursor:pointer; }
		.som-link { color:#3b82f6; font-weight:600; text-decoration:none; }
		.som-link:hover { text-decoration:underline; }
		.som-customer { max-width: 180px; }
		.som-date { white-space: nowrap; color: #64748b; }
		.som-owner { color: #64748b; font-size:12px; }
		.som-amount { font-weight: 600; font-family: monospace; font-size: 13px; }
		.som-na { color: #cbd5e1; }

		.som-region-tag {
			display: inline-block;
			padding: 2px 8px;
			background: #e0f2fe;
			border-radius: 4px;
			font-size: 11px;
			font-weight: 600;
			color: #0369a1;
		}

		/* Badges */
		.som-badge {
			display: inline-block;
			padding: 3px 10px;
			border-radius: 20px;
			font-size: 11px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: .4px;
		}
		.som-badge-ready { background:#dcfce7; color:#166534; }
		.som-badge-held  { background:#fef3c7; color:#92400e; }

		/* Expand button */
		.som-expand-btn {
			background: none;
			border: none;
			cursor: pointer;
			font-size: 16px;
			color: #94a3b8;
			padding: 0 4px;
			line-height: 1;
			transition: color .15s;
		}
		.som-expand-btn:hover { color: #3b82f6; }

		/* Hold button */
		.som-hold-btn {
			border: none;
			border-radius: 6px;
			width: 32px;
			height: 28px;
			cursor: pointer;
			font-size: 14px;
			transition: opacity .15s;
		}
		.som-hold-btn:hover { opacity: .8; }
		.som-hold-btn-hold    { background: #fef3c7; color: #92400e; }
		.som-hold-btn-release { background: #dcfce7; color: #166534; }

		/* Expanded items */
		.som-items-row td {
			padding: 0 !important;
			background: #f8fafc;
			border-bottom: 2px solid #e2e8f0;
		}
		.som-items-wrap { padding: 16px 20px; }
		.som-items-loading { color:#94a3b8; padding:16px 20px; font-size:13px; }
		.som-items-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}
		.som-items-table thead th {
			background: #e2e8f0;
			color: #475569;
			font-size: 11px;
			font-weight: 700;
			text-transform: uppercase;
			padding: 8px 10px;
			border: none;
		}
		.som-items-table td {
			padding: 8px 10px;
			border-bottom: 1px solid #e2e8f0;
			vertical-align: middle;
		}
		.som-items-table tr:last-child td { border-bottom: none; }
		.som-item-name { color: #64748b; }
		</style>`;
	}
}
