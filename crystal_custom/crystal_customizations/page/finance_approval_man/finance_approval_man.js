frappe.pages['finance-approval-man'].on_page_load = function (wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Finance Approval',
		single_column: true,
	});
	new FinanceApprovalManager(page);
};

class FinanceApprovalManager {
	constructor(page) {
		this.page = page;
		this.orders = [];
		this.financials = {};   // keyed by customer
		this.setup_page();
		this.load_data();
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	setup_page() {
		const today = frappe.datetime.get_today();

		this.page.add_field({
			label: 'From Date', fieldtype: 'Date', fieldname: 'from_date',
			default: frappe.datetime.add_days(today, -7),
			change: () => this.render_orders(),
		});
		this.page.add_field({
			label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
			default: today,
			change: () => this.render_orders(),
		});
		this.page.add_field({
			label: 'Sales Person', fieldtype: 'Link', fieldname: 'sales_person',
			options: 'Sales Person',
			change: () => this.load_data(),
		});
		this.page.add_field({
			label: 'Delivery Region', fieldtype: 'Link', fieldname: 'delivery_region',
			options: 'Territory',
			change: () => this.render_orders(),
		});

		this.page.set_primary_action('Approve Selected', () => this.approve_selected(), 'octicon octicon-check');
		this.page.add_button('Reject Selected', () => this.reject_selected(), 'octicon octicon-x');
		this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');

		this.container = $('<div class="fa-container"></div>').appendTo(this.page.main);
	}

	// ── Data loading ──────────────────────────────────────────────────────────

	load_data() {
		this.container.html(this._loading_html());

		const sp = this.page.fields_dict.sales_person.get_value();
		const filters = [['Sales Order', 'docstatus', '=', 0],
		                 ['Sales Order', 'workflow_state', '=', 'Pending Finance Approval']];
		if (sp) filters.push(['Sales Team', 'sales_person', '=', sp]);

		frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Sales Order',
				fields: [
					'name', 'customer', 'customer_name', 'transaction_date',
					'grand_total', 'custom_delivery_region', 'owner', 'workflow_state',
				],
				filters,
				limit_page_length: 500,
			},
			callback: (r) => {
				this.orders = r.message || [];
				if (!this.orders.length) {
					this.render_orders();
					return;
				}
				const customers = [...new Set(this.orders.map(o => o.customer))];
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.finance_approval_man.finance_approval_man.get_customer_financial_summary',
					args: { customers: JSON.stringify(customers) },
					callback: (r2) => {
						this.financials = r2.message || {};
						this.render_orders();
					},
					error: () => {
						this.financials = {};
						this.render_orders();
					},
				});
			},
		});
	}

	get_filtered_orders() {
		const from   = this.page.fields_dict.from_date.get_value();
		const to     = this.page.fields_dict.to_date.get_value();
		const region = this.page.fields_dict.delivery_region.get_value();

		return this.orders.filter(o => {
			if (from   && o.transaction_date < from)                  return false;
			if (to     && o.transaction_date > to)                    return false;
			if (region && o.custom_delivery_region !== region)        return false;
			return true;
		});
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	render_orders() {
		const orders = this.get_filtered_orders();

		if (!orders.length) {
			this.container.html(`
				<div class="alert alert-info" style="margin-top:20px;">
					<strong>No orders pending finance approval</strong>
					${this.orders.length ? ' — try clearing your filters.' : '.'}
				</div>`);
			return;
		}

		const total_value    = orders.reduce((s, o) => s + o.grand_total, 0);
		const total_overdue  = orders.reduce((s, o) => s + (this.financials[o.customer]?.overdue || 0), 0);
		const pdc_customers  = orders.filter(o => (this.financials[o.customer]?.pdc_count || 0) > 0).length;

		let html = `
		<div class="fa-summary-row">
			${this._kpi('Pending',       orders.length,                  '#667eea')}
			${this._kpi('Total Value',   format_currency(total_value),   '#10b981')}
			${this._kpi('Total Overdue', format_currency(total_overdue), '#ef4444')}
			${this._kpi('PDC Customers', pdc_customers,                  '#f59e0b')}
		</div>

		<div class="fa-table-wrap">
		<div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
			<label style="font-weight:600;cursor:pointer;">
				<input type="checkbox" id="fa-select-all" style="margin-right:6px;">
				Select All (${orders.length})
			</label>
		</div>
		<table class="table table-bordered fa-table">
			<thead><tr>
				<th width="3%"></th>
				<th width="12%">Sales Order</th>
				<th width="14%">Customer</th>
				<th width="9%">Order Amt</th>
				<th width="9%">Outstanding</th>
				<th width="9%">Overdue</th>
				<th width="9%">Credit Limit</th>
				<th width="10%">Terms</th>
				<th width="8%">PDC Today</th>
				<th width="8%">Region</th>
				<th width="9%">Date</th>
			</tr></thead>
			<tbody>`;

		orders.forEach(o => {
			const fin  = this.financials[o.customer] || {};
			const avail = (fin.credit_limit || 0) - (fin.outstanding || 0);
			const over_limit = (fin.outstanding || 0) + o.grand_total > (fin.credit_limit || 0);
			const has_pdc    = (fin.pdc_count || 0) > 0;
			const has_overdue = (fin.overdue || 0) > 0;

			html += `
			<tr class="fa-row ${over_limit ? 'fa-row-warn' : ''}" data-order="${o.name}">
				<td><input type="checkbox" class="fa-chk" data-order="${o.name}" data-owner="${o.owner}"></td>
				<td><a href="/app/sales-order/${o.name}" target="_blank">${o.name}</a></td>
				<td title="${o.customer}">${o.customer_name || o.customer}</td>
				<td class="fa-amt">${format_currency(o.grand_total)}</td>
				<td class="fa-amt ${(fin.outstanding || 0) > 0 ? 'fa-red' : ''}">${format_currency(fin.outstanding || 0)}</td>
				<td class="fa-amt ${has_overdue ? 'fa-red fa-bold' : ''}">${format_currency(fin.overdue || 0)}</td>
				<td class="fa-amt">${format_currency(fin.credit_limit || 0)}</td>
				<td><span class="fa-tag">${fin.payment_terms || '—'}</span></td>
				<td>${has_pdc
					? `<span class="fa-pdc-badge" title="${format_currency(fin.pdc_amount)} in PDC cheques">
						${fin.pdc_count} cheque${fin.pdc_count > 1 ? 's' : ''}
					   </span>`
					: '<span class="text-muted">—</span>'}
				</td>
				<td><span class="fa-tag">${o.custom_delivery_region || '—'}</span></td>
				<td>${frappe.datetime.str_to_user(o.transaction_date)}</td>
			</tr>`;
		});

		html += `</tbody></table></div>${this._styles()}`;
		this.container.html(html);
		this._attach_events();
	}

	_kpi(label, value, color) {
		return `<div class="fa-kpi" style="border-top:4px solid ${color}">
			<div class="fa-kpi-label">${label}</div>
			<div class="fa-kpi-value" style="color:${color}">${value}</div>
		</div>`;
	}

	_loading_html() {
		return `<div style="text-align:center;padding:60px;">
			<div class="text-muted"><i class="fa fa-spinner fa-spin fa-2x"></i><br><br>Loading orders…</div>
		</div>`;
	}

	_attach_events() {
		$('#fa-select-all').off('change').on('change', function () {
			$('.fa-chk').prop('checked', $(this).is(':checked'));
		});
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	_get_selected() {
		const sel = [];
		$('.fa-chk:checked').each(function () {
			sel.push({ order: $(this).data('order'), owner: $(this).data('owner') });
		});
		return sel;
	}

	approve_selected() {
		const selected = this._get_selected();
		if (!selected.length) { frappe.msgprint(__('Select at least one order.')); return; }

		frappe.confirm(
			__('Approve {0} order(s) and send to Customer Confirmation?', [selected.length]),
			() => this._process_batch(selected.map(s => s.order), 'Pending Customer Order Reconfirmation', null)
		);
	}

	reject_selected() {
		const selected = this._get_selected();
		if (!selected.length) { frappe.msgprint(__('Select at least one order.')); return; }

		frappe.prompt(
			[{ label: 'Rejection Reason', fieldname: 'reason', fieldtype: 'Small Text', reqd: 1 }],
			(vals) => {
				frappe.confirm(
					__('Reject {0} order(s)?', [selected.length]),
					() => this._process_rejections(selected, vals.reason)
				);
			},
			__('Rejection Reason'), __('Reject')
		);
	}

	_process_batch(order_names, target_state, callback) {
		let done = 0, errors = [];

		const next = () => {
			if (done >= order_names.length) {
				if (errors.length) {
					frappe.msgprint({ title: __('Done with errors'),
						message: errors.join('<br>'), indicator: 'orange' });
				} else {
					frappe.show_alert({ message: __('Done — {0} orders updated', [order_names.length]),
						indicator: 'green' });
				}
				if (callback) callback();
				this.load_data();
				return;
			}
			const name = order_names[done];
			frappe.call({
				method: 'frappe.client.set_value',
				args: { doctype: 'Sales Order', name, fieldname: 'workflow_state', value: target_state },
				callback: (r) => {
					frappe.show_alert({ message: name, indicator: r.message ? 'green' : 'orange' });
					if (!r.message) errors.push(name);
					done++; next();
				},
				error: () => { errors.push(name); done++; next(); },
			});
		};

		frappe.show_alert({ message: __('Processing…'), indicator: 'blue' });
		next();
	}

	_process_rejections(selected, reason) {
		let done = 0, errors = [];

		const next = () => {
			if (done >= selected.length) {
				if (errors.length) {
					frappe.msgprint({ title: __('Done with errors'), message: errors.join('<br>'), indicator: 'orange' });
				} else {
					frappe.show_alert({ message: __('{0} orders rejected', [selected.length]), indicator: 'red' });
				}
				this.load_data();
				return;
			}
			const { order, owner } = selected[done];

			// 1. Send notification to submitter
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.finance_approval_man.finance_approval_man.notify_rejection',
				args: { order_name: order, reason, owner },
			});

			// 2. Add comment
			frappe.call({
				method: 'frappe.desk.form.utils.add_comment',
				args: {
					reference_doctype: 'Sales Order', reference_name: order,
					content: `<strong>Finance Rejected:</strong> ${reason}`,
					comment_email: frappe.session.user,
					comment_by: frappe.session.user_fullname,
				},
				callback: () => {
					// 3. Reset workflow so it reappears in Order Manager
					frappe.call({
						method: 'frappe.client.set_value',
						args: { doctype: 'Sales Order', name: order, fieldname: 'workflow_state', value: 'Proceed To Order' },
						callback: (r) => {
							frappe.show_alert({ message: __('Rejected {0}', [order]), indicator: 'red' });
							if (!r.message) errors.push(order);
							done++; next();
						},
						error: () => { errors.push(order); done++; next(); },
					});
				},
			});
		};

		frappe.show_alert({ message: __('Rejecting orders…'), indicator: 'orange' });
		next();
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	_styles() {
		return `<style>
		.fa-container { margin-top: 16px; }
		.fa-summary-row {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
			gap: 16px;
			margin-bottom: 24px;
		}
		.fa-kpi {
			background: #fff;
			border-radius: 8px;
			padding: 16px 20px;
			box-shadow: 0 1px 6px rgba(0,0,0,.07);
		}
		.fa-kpi-label { font-size: 12px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
		.fa-kpi-value { font-size: 22px; font-weight: 700; margin-top: 6px; }
		.fa-table-wrap {
			background: #fff;
			border-radius: 8px;
			padding: 16px;
			box-shadow: 0 1px 6px rgba(0,0,0,.07);
			overflow-x: auto;
		}
		.fa-table thead th {
			background: #1e293b;
			color: #fff;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: .4px;
			padding: 12px 10px !important;
			border: none !important;
			white-space: nowrap;
		}
		.fa-row td { padding: 11px 10px !important; vertical-align: middle !important; font-size: 13px; }
		.fa-row:hover { background: #f8fafc !important; }
		.fa-row-warn { border-left: 3px solid #ef4444 !important; background: #fff5f5; }
		.fa-amt { text-align: right; font-family: monospace; font-size: 13px; }
		.fa-red { color: #dc2626; }
		.fa-bold { font-weight: 700; }
		.fa-tag {
			display: inline-block;
			padding: 2px 8px;
			background: #f1f5f9;
			border-radius: 4px;
			font-size: 12px;
			color: #475569;
		}
		.fa-pdc-badge {
			display: inline-block;
			padding: 3px 9px;
			background: #fef3c7;
			border: 1px solid #f59e0b;
			border-radius: 4px;
			font-size: 12px;
			font-weight: 600;
			color: #92400e;
			cursor: default;
		}
		</style>`;
	}
}
