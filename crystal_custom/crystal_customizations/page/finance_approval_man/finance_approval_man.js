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
		this.current_page = 1;
		this.page_size = 50;
		this._sps = new Set();
		this.setup_page();
		this.load_data();
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	setup_page() {
		const today = frappe.datetime.get_today();

		this.page.add_field({
			label: 'From Date', fieldtype: 'Date', fieldname: 'from_date',
			default: frappe.datetime.add_days(today, -7),
			change: () => { this.current_page = 1; this.render_orders(); },
		});
		this.page.add_field({
			label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
			default: today,
			change: () => { this.current_page = 1; this.render_orders(); },
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
			}
		});
		this._sp_pills_wrap = $('<div class="sp-pills-wrap"></div>').appendTo(this.page.page_form);
		this.page.add_field({
			label: 'Delivery Region', fieldtype: 'Link', fieldname: 'delivery_region',
			options: 'Delivery Region',
			change: () => { this.current_page = 1; this.render_orders(); },
		});

		this.page.set_primary_action('Approve Selected', () => this.approve_selected(), 'octicon octicon-check');
		this.page.add_button('Reject Selected', () => this.reject_selected(), 'octicon octicon-x');
		this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');

		this.container = $('<div class="fa-container"></div>').appendTo(this.page.main);
	}

	// ── Data loading ──────────────────────────────────────────────────────────

	load_data() {
		this.container.html(this._loading_html());

		const filters = [['Sales Order', 'docstatus', '=', 0],
		                 ['Sales Order', 'workflow_state', '=', 'Pending Finance Approval']];
		if (this._sps.size) filters.push(['Sales Team', 'sales_person', 'in', [...this._sps]]);

		frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Sales Order',
				fields: [
					'name', 'customer', 'customer_name', 'transaction_date',
					'grand_total', 'custom_delivery_region', 'owner', 'workflow_state',
					'custom_finance_rejection_note', 'custom_resubmission_note',
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
						this.current_page = 1;
						this.render_orders();
					},
					error: () => {
						this.financials = {};
						this.current_page = 1;
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
		const all_orders = this.get_filtered_orders();
		const total_pages = Math.ceil(all_orders.length / this.page_size) || 1;
		if (this.current_page > total_pages) this.current_page = total_pages;
		const orders = all_orders.slice(
			(this.current_page - 1) * this.page_size,
			this.current_page * this.page_size
		);

		if (!all_orders.length) {
			this.container.html(`
				<div class="alert alert-info" style="margin-top:20px;">
					<strong>No orders pending finance approval</strong>
					${this.orders.length ? ' — try clearing your filters.' : '.'}
				</div>`);
			return;
		}

		const total_value    = all_orders.reduce((s, o) => s + o.grand_total, 0);
		const total_overdue  = all_orders.reduce((s, o) => s + (this.financials[o.customer]?.overdue || 0), 0);
		const pdc_customers  = all_orders.filter(o => (this.financials[o.customer]?.pdc_count || 0) > 0).length;

		let html = `
		<div class="fa-summary-row">
			${this._kpi('Pending',       orders.length,                  '#667eea')}
			${this._kpi('Total Value',   format_currency(total_value),   '#10b981')}
			${this._kpi('Total Overdue', format_currency(total_overdue), '#ef4444')}
			${this._kpi('Upcoming Payments', pdc_customers,                '#f59e0b')}
		</div>

		<div class="fa-table-wrap">
		<div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
			<label style="font-weight:600;cursor:pointer;">
				<input type="checkbox" id="fa-select-all" style="margin-right:6px;">
				Select All (${all_orders.length})
			</label>
			<span style="font-size:12px;color:#6b7280;">
				${all_orders.length} order${all_orders.length !== 1 ? 's' : ''}
				${this.orders.length !== all_orders.length ? ` (filtered from ${this.orders.length})` : ''}
			</span>
		</div>
		<table class="table table-bordered fa-table">
			<thead><tr>
				<th width="3%"></th>
				<th width="18%">Sales Order</th>
				<th width="12%">Customer</th>
				<th width="8%">Order Amt</th>
				<th width="8%">Outstanding</th>
				<th width="8%">Overdue</th>
				<th width="8%">Credit Limit</th>
				<th width="8%">Terms</th>
				<th width="7%">Upcoming Pmts</th>
				<th width="7%">Region</th>
				<th width="7%">Date</th>
			</tr></thead>
			<tbody>`;

		orders.forEach(o => {
			const fin  = this.financials[o.customer] || {};
			const avail = (fin.credit_limit || 0) - (fin.outstanding || 0);
			const over_limit = (fin.outstanding || 0) + o.grand_total > (fin.credit_limit || 0);
			const has_pdc    = (fin.pdc_count || 0) > 0;
			const has_overdue = (fin.overdue || 0) > 0;
			const is_resub   = !!o.custom_resubmission_note;

			html += `
			<tr class="fa-row ${over_limit ? 'fa-row-warn' : ''} ${is_resub ? 'fa-row-resub' : ''}" data-order="${o.name}">
				<td><input type="checkbox" class="fa-chk" data-order="${o.name}" data-owner="${o.owner}"></td>
				<td>
					<a href="/app/sales-order/${o.name}" target="_blank">${o.name}</a>
					${is_resub ? '<span class="fa-resub-badge">Re-submitted</span>' : ''}
					${o.custom_finance_rejection_note ? `
					<div class="fa-note fa-note-rejection">
						<span class="fa-note-label">Prev. rejection:</span>
						${frappe.utils.escape_html(o.custom_finance_rejection_note)}
					</div>` : ''}
					${o.custom_resubmission_note ? `
					<div class="fa-note fa-note-resub">
						<span class="fa-note-label">Resubmission note:</span>
						${frappe.utils.escape_html(o.custom_resubmission_note)}
					</div>` : ''}
				</td>
				<td title="${o.customer}">${o.customer_name || o.customer}</td>
				<td class="fa-amt">${format_currency(o.grand_total)}</td>
				<td class="fa-amt ${(fin.outstanding || 0) > 0 ? 'fa-red' : ''}">
					${format_currency(fin.outstanding || 0)}
					${(fin.outstanding || 0) > 0 ? `
					<div class="fa-aging">
						${fin.aging_0_30   > 0 ? `<span class="fa-age fa-age-1">1–30d: ${format_currency(fin.aging_0_30,   null, 0)}</span>` : ''}
						${fin.aging_31_60  > 0 ? `<span class="fa-age fa-age-2">31–60d: ${format_currency(fin.aging_31_60, null, 0)}</span>` : ''}
						${fin.aging_61_90  > 0 ? `<span class="fa-age fa-age-3">61–90d: ${format_currency(fin.aging_61_90, null, 0)}</span>` : ''}
						${fin.aging_90_plus > 0 ? `<span class="fa-age fa-age-4">90+d: ${format_currency(fin.aging_90_plus, null, 0)}</span>` : ''}
					</div>` : ''}
				</td>
				<td class="fa-amt ${has_overdue ? 'fa-red fa-bold' : ''}">${format_currency(fin.overdue || 0)}</td>
				<td class="fa-amt">${format_currency(fin.credit_limit || 0)}</td>
				<td><span class="fa-tag">${fin.payment_terms || '—'}</span></td>
				<td>${has_pdc
					? `<span class="fa-pdc-badge" title="${format_currency(fin.pdc_amount)}">
						${fin.pdc_count} payment${fin.pdc_count > 1 ? 's' : ''}
					   </span>`
					: '<span class="text-muted">—</span>'}
				</td>
				<td><span class="fa-tag">${o.custom_delivery_region || '—'}</span></td>
				<td>${frappe.datetime.str_to_user(o.transaction_date)}</td>
			</tr>`;
		});

		html += `</tbody></table>
		${this._pagination_html(all_orders.length)}
		</div>${this._styles()}`;
		this.container.html(html);
		this._attach_events();
	}

	_pagination_html(total) {
		if (total <= this.page_size) return '';
		const total_pages = Math.ceil(total / this.page_size);
		const start = (this.current_page - 1) * this.page_size + 1;
		const end   = Math.min(this.current_page * this.page_size, total);
		return `<div class="fa-pg-bar">
			<button class="btn btn-xs btn-default fa-pg-prev" ${this.current_page <= 1 ? 'disabled' : ''}>&lsaquo; Prev</button>
			<span class="fa-pg-info">Showing ${start}–${end} of ${total} &nbsp;·&nbsp; Page ${this.current_page} of ${total_pages}</span>
			<button class="btn btn-xs btn-default fa-pg-next" ${this.current_page >= total_pages ? 'disabled' : ''}>Next &rsaquo;</button>
		</div>`;
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

		this.container.find('.fa-pg-prev').on('click', () => {
			if (this.current_page > 1) { this.current_page--; this.render_orders(); }
		});
		this.container.find('.fa-pg-next').on('click', () => {
			const tp = Math.ceil(this.get_filtered_orders().length / this.page_size);
			if (this.current_page < tp) { this.current_page++; this.render_orders(); }
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
			() => this._do_approve(selected.map(s => s.order))
		);
	}

	_do_approve(order_names) {
		frappe.show_alert({ message: __('Approving…'), indicator: 'blue' });
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.finance_approval_man.finance_approval_man.approve_orders',
			args: { order_names: JSON.stringify(order_names) },
			callback: (r) => {
				const result  = r.message || {};
				const updated = result.updated || [];
				const skipped = result.skipped || [];
				if (skipped.length) {
					frappe.msgprint({
						title: __('Done with skips'),
						message: __('Approved {0}. Skipped {1} (state mismatch): {2}',
							[updated.length, skipped.length, skipped.join(', ')]),
						indicator: 'orange',
					});
				} else {
					frappe.show_alert({
						message: __('Done — {0} orders approved', [updated.length]),
						indicator: 'green',
					});
				}
				this.load_data();
			},
		});
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
			const fields = { workflow_state: target_state };
			if (target_state === 'Pending Customer Order Reconfirmation') {
				fields.custom_finance_rejection_note = '';
			}
			frappe.call({
				method: 'frappe.client.set_value',
				args: { doctype: 'Sales Order', name, fieldname: fields },
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
					// 3. Reset workflow + save rejection note via direct DB write
					frappe.call({
						method: 'crystal_custom.crystal_customizations.page.finance_approval_man.finance_approval_man.reject_order_state',
						args: { order_name: order, reason },
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
		.fa-row td { padding: 11px 10px !important; vertical-align: top !important; font-size: 13px; }
		.fa-row:hover { background: #f8fafc !important; }
		.fa-row-warn { border-left: 3px solid #ef4444 !important; background: #fff5f5; }
		.fa-row-resub { border-left: 3px solid #8b5cf6 !important; }
		.fa-resub-badge {
			display: inline-block;
			margin-left: 6px;
			padding: 1px 7px;
			background: #ede9fe;
			color: #6d28d9;
			border-radius: 3px;
			font-size: 10px;
			font-weight: 700;
			vertical-align: middle;
			text-transform: uppercase;
			letter-spacing: .3px;
		}
		.fa-note {
			margin-top: 5px;
			padding: 5px 8px;
			border-radius: 4px;
			font-size: 11px;
			line-height: 1.5;
		}
		.fa-note-rejection {
			background: #fff5f5;
			border-left: 3px solid #ef4444;
			color: #7f1d1d;
		}
		.fa-note-resub {
			background: #f5f3ff;
			border-left: 3px solid #8b5cf6;
			color: #4c1d95;
		}
		.fa-note-label {
			font-weight: 700;
			display: block;
			margin-bottom: 2px;
		}
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
		.fa-aging { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 3px; justify-content: flex-end; }
		.fa-age {
			display: inline-block;
			padding: 1px 5px;
			border-radius: 3px;
			font-size: 10px;
			font-weight: 600;
			white-space: nowrap;
		}
		.fa-age-1 { background: #fef3c7; color: #92400e; }
		.fa-age-2 { background: #fed7aa; color: #9a3412; }
		.fa-age-3 { background: #fecaca; color: #991b1b; }
		.fa-age-4 { background: #dc2626; color: #fff; }
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
		.fa-pg-bar {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 14px;
			padding: 12px 16px;
			border-top: 1px solid #e2e8f0;
			background: #f8fafc;
			margin-top: 4px;
		}
		.fa-pg-info { font-size: 13px; color: #64748b; }
		.fa-pg-bar .btn { min-width: 70px; }
		</style>`;
	}
}
