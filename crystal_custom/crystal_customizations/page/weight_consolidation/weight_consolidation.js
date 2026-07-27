frappe.pages['weight-consolidation'].on_page_load = function (wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Weight Consolidation',
		single_column: true,
	});
	new WeightConsolidationManager(page);
};

class WeightConsolidationManager {
	constructor(page) {
		this.page   = page;
		this.orders = [];
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
			change: () => this.render(),
		});
		this.page.add_field({
			label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
			default: today,
			change: () => this.render(),
		});
		this.page.add_field({
			label: 'Region', fieldtype: 'Link', fieldname: 'delivery_region',
			options: 'Delivery Region',
			change: () => this.render(),
		});
		this.page.add_field({
			label: 'Status', fieldtype: 'Select', fieldname: 'workflow_state',
			options: '\nPending Customer Order Reconfirmation\nPending Finance Approval\nOrder Confirmed\nProceed To Order',
			default: 'Pending Customer Order Reconfirmation',
			change: () => this.load_data(),
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

		this.page.set_primary_action('Download', () => this.download(), 'octicon octicon-cloud-download');
		this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');

		this.container = $('<div class="wc-container"></div>').appendTo(this.page.main);
	}

	// ── Data loading ──────────────────────────────────────────────────────────

	load_data() {
		this.container.html(this._loading_html());

		const workflow_state = this.page.fields_dict.workflow_state.get_value();
		const filters = [
			['Sales Order', 'docstatus', '!=', 2],
			['Sales Order', 'per_delivered', '=', 0],
			['Sales Order', 'per_billed', '=', 0],
		];
		if (workflow_state) filters.push(['Sales Order', 'workflow_state', '=', workflow_state]);
		if (this._sps.size) filters.push(['Sales Team', 'sales_person', 'in', [...this._sps]]);

		frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Sales Order',
				fields: [
					'name', 'customer', 'customer_name', 'transaction_date',
					'grand_total', 'custom_delivery_region', 'owner',
					'total_net_weight', 'workflow_state', 'docstatus',
				],
				filters,
				order_by: 'transaction_date desc',
				limit_page_length: 1000,
			},
			callback: (r) => {
				this.orders = r.message || [];
				this.render();
			},
		});
	}

	filtered_orders() {
		const from   = this.page.fields_dict.from_date.get_value();
		const to     = this.page.fields_dict.to_date.get_value();
		const region = this.page.fields_dict.delivery_region.get_value();
		return this.orders.filter(o => {
			if (from   && o.transaction_date < from)             return false;
			if (to     && o.transaction_date > to)               return false;
			if (region && o.custom_delivery_region !== region)   return false;
			return true;
		});
	}

	// ── Render ────────────────────────────────────────────────────────────────

	render() {
		const orders = this.filtered_orders();
		const region = this.page.fields_dict.delivery_region.get_value();

		if (!orders.length) {
			this.container.html(`
				${this._styles()}
				<div class="wc-empty">
					<div class="wc-empty-icon">⚖️</div>
					<div class="wc-empty-title">No orders found</div>
					<div class="wc-empty-sub">
						${this.orders.length
							? 'No orders match the current filters.'
							: 'No open sales orders without delivery notes/invoices in this date range.'}
					</div>
				</div>`);
			return;
		}

		// Group by region
		const region_map = {};
		orders.forEach(o => {
			const key = o.custom_delivery_region || '__none__';
			if (!region_map[key]) region_map[key] = { orders: [], weight: 0, value: 0 };
			region_map[key].orders.push(o);
			region_map[key].weight += o.total_net_weight || 0;
			region_map[key].value  += o.grand_total      || 0;
		});

		const total_weight  = orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
		const total_value   = orders.reduce((s, o) => s + (o.grand_total      || 0), 0);
		const region_count  = Object.keys(region_map).filter(k => k !== '__none__').length;
		const zero_wt_count = orders.filter(o => !(o.total_net_weight > 0)).length;

		// 4th KPI: when region is filtered show that region's weight, otherwise # regions
		const kpi4_label = region ? `${region} Weight` : 'Regions';
		const kpi4_value = region
			? (region_map[region] || { weight: 0 }).weight.toFixed(1) + ' kg'
			: region_count;

		let html = `
		${this._styles()}
		<div class="wc-kpi-row">
			${this._kpi('Orders',       orders.length,                        '#3b82f6', '📦')}
			${this._kpi('Total Weight', total_weight.toFixed(1) + ' kg',      '#10b981', '⚖️')}
			${this._kpi('Total Value',  format_currency(total_value),         '#f59e0b', '💰')}
			${this._kpi(kpi4_label,     kpi4_value,                           '#8b5cf6', '🗺️')}
		</div>

		${zero_wt_count > 0 ? `
		<div class="wc-alert">
			⚠️ <strong>${zero_wt_count} order${zero_wt_count !== 1 ? 's' : ''}</strong> have no weight set — totals may be incomplete.
		</div>` : ''}

		<div class="wc-card">
		<table class="wc-table">
			<thead><tr>
				<th>Sales Order</th>
				<th>Customer</th>
				<th>Date</th>
				<th>Region</th>
				<th>Sales Person</th>
				<th class="wc-r">Weight (kg)</th>
				<th class="wc-r">Amount</th>
				<th>Status</th>
			</tr></thead>
			<tbody>`;

		const sorted_keys = Object.keys(region_map).sort((a, b) => {
			if (a === '__none__') return 1;
			if (b === '__none__') return -1;
			return a.localeCompare(b);
		});

		sorted_keys.forEach(key => {
			const rd    = region_map[key];
			const label = key === '__none__' ? 'No Region' : key;

			html += `
			<tr class="wc-region-row">
				<td colspan="5">
					<strong>${frappe.utils.escape_html(label)}</strong>
					<span class="wc-region-meta">${rd.orders.length} order${rd.orders.length !== 1 ? 's' : ''}</span>
				</td>
				<td class="wc-r wc-region-weight"><strong>${rd.weight.toFixed(1)} kg</strong></td>
				<td class="wc-r wc-region-value">${format_currency(rd.value, null, 0)}</td>
				<td></td>
			</tr>`;

			rd.orders.forEach(o => {
				const wt = o.total_net_weight || 0;
				html += `
				<tr class="wc-row">
					<td><a href="/app/sales-order/${o.name}" target="_blank" class="wc-link">${o.name}</a></td>
					<td class="wc-customer">${frappe.utils.escape_html(o.customer_name || o.customer)}</td>
					<td class="wc-date">${frappe.datetime.str_to_user(o.transaction_date)}</td>
					<td>${o.custom_delivery_region
						? `<span class="wc-region-tag">${frappe.utils.escape_html(o.custom_delivery_region)}</span>`
						: '<span class="wc-na">—</span>'}
					</td>
					<td class="wc-owner">${frappe.user.full_name(o.owner) || o.owner}</td>
					<td class="wc-r wc-weight${wt === 0 ? ' wc-zero' : ''}">${wt > 0 ? wt.toFixed(1) : '—'}</td>
					<td class="wc-r wc-amount">${format_currency(o.grand_total)}</td>
					<td>${this._status_badge(o)}</td>
				</tr>`;
			});
		});

		// Grand total row
		html += `
			<tr class="wc-total-row">
				<td colspan="5" style="text-align:right">GRAND TOTAL</td>
				<td class="wc-r"><strong>${total_weight.toFixed(1)} kg</strong></td>
				<td class="wc-r"><strong>${format_currency(total_value)}</strong></td>
				<td></td>
			</tr>
		</tbody></table>
		</div>`;

		this.container.html(html);
	}

	// ── Download ──────────────────────────────────────────────────────────────

	download() {
		const orders = this.filtered_orders();
		if (!orders.length) { frappe.msgprint(__('No data to download.')); return; }

		const from   = this.page.fields_dict.from_date.get_value() || '';
		const to     = this.page.fields_dict.to_date.get_value()   || '';
		const region = this.page.fields_dict.delivery_region.get_value() || '';

		const region_map = {};
		orders.forEach(o => {
			const key = o.custom_delivery_region || 'No Region';
			if (!region_map[key]) region_map[key] = { orders: [], weight: 0, value: 0 };
			region_map[key].orders.push(o);
			region_map[key].weight += o.total_net_weight || 0;
			region_map[key].value  += o.grand_total      || 0;
		});

		const total_weight = orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
		const total_value  = orders.reduce((s, o) => s + (o.grand_total      || 0), 0);

		let rows = '';
		Object.keys(region_map).sort().forEach(r_key => {
			const rd = region_map[r_key];
			rows += `<tr style="background:#1e293b;color:#fff;font-weight:bold;">
				<td colspan="7">${r_key} — ${rd.orders.length} order(s) — ${rd.weight.toFixed(2)} kg — ${rd.value.toFixed(2)}</td>
			</tr>`;
			rd.orders.forEach(o => {
				rows += `<tr>
					<td>${o.name}</td>
					<td>${o.customer_name || o.customer}</td>
					<td>${o.transaction_date}</td>
					<td>${o.custom_delivery_region || ''}</td>
					<td>${frappe.user.full_name(o.owner) || o.owner}</td>
					<td style="text-align:right">${(o.total_net_weight || 0).toFixed(2)}</td>
					<td style="text-align:right">${(o.grand_total || 0).toFixed(2)}</td>
				</tr>`;
			});
			rows += `<tr style="background:#f1f5f9;font-weight:bold;">
				<td colspan="5" style="text-align:right">${r_key} Subtotal</td>
				<td style="text-align:right">${rd.weight.toFixed(2)}</td>
				<td style="text-align:right">${rd.value.toFixed(2)}</td>
			</tr>`;
		});
		rows += `<tr style="background:#0f172a;color:#fff;font-weight:bold;">
			<td colspan="5" style="text-align:right">GRAND TOTAL</td>
			<td style="text-align:right">${total_weight.toFixed(2)}</td>
			<td style="text-align:right">${total_value.toFixed(2)}</td>
		</tr>`;

		const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
			xmlns:x="urn:schemas-microsoft-com:office:excel"
			xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<style>
  table{border-collapse:collapse}
  th,td{border:1px solid #ddd;padding:8px 10px;text-align:left;font-family:sans-serif;font-size:12px}
  th{background:#1e293b;color:#fff}
</style>
</head><body>
<h2 style="font-family:sans-serif">WEIGHT CONSOLIDATION REPORT</h2>
<p style="font-family:sans-serif;color:#555;font-size:12px">
  Period: ${from || 'all'} to ${to || 'all'}
  ${region ? ' &nbsp;|&nbsp; Region: ' + region : ''}
  &nbsp;|&nbsp; Orders: ${orders.length}
  &nbsp;|&nbsp; Total Weight: ${total_weight.toFixed(2)} kg
  &nbsp;|&nbsp; Total Value: ${total_value.toFixed(2)}
</p>
<table>
  <thead><tr>
    <th>Sales Order</th><th>Customer</th><th>Date</th><th>Region</th>
    <th>Sales Person</th><th>Weight (kg)</th><th>Amount</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;

		const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
		const a    = document.createElement('a');
		a.href     = URL.createObjectURL(blob);
		a.download = `Weight_Consolidation_${from || 'all'}_to_${to || 'all'}.xls`;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		frappe.show_alert({ message: __('Report downloaded'), indicator: 'green' });
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

	// ── Helpers ───────────────────────────────────────────────────────────────

	_status_badge(o) {
		if (o.docstatus === 0 || o.docstatus === '0') {
			const label = o.workflow_state || 'Draft';
			return `<span class="wc-badge" style="background:#fef9c3;color:#854d0e;">${frappe.utils.escape_html(label)}</span>`;
		}
		return `<span class="wc-badge wc-badge-ready">Submitted</span>`;
	}

	_kpi(label, value, color, icon) {
		return `<div class="wc-kpi" style="border-top:4px solid ${color}">
			<div class="wc-kpi-icon" style="color:${color}">${icon}</div>
			<div class="wc-kpi-body">
				<div class="wc-kpi-label">${label}</div>
				<div class="wc-kpi-val" style="color:${color}">${value}</div>
			</div>
		</div>`;
	}

	_loading_html() {
		return `<div style="text-align:center;padding:60px;color:#9ca3af;">
			<i class="fa fa-spinner fa-spin fa-2x"></i><br><br>Loading…
		</div>`;
	}

	_styles() {
		return `<style>
		.wc-container { margin-top: 16px; }

		/* Empty state */
		.wc-empty { text-align:center; padding:80px 20px; }
		.wc-empty-icon  { font-size:48px; margin-bottom:16px; }
		.wc-empty-title { font-size:20px; font-weight:700; color:#1e293b; margin-bottom:8px; }
		.wc-empty-sub   { color:#6b7280; font-size:14px; }

		/* Warning banner */
		.wc-alert {
			background: #fffbeb;
			border: 1px solid #fde68a;
			border-left: 4px solid #f59e0b;
			border-radius: 6px;
			padding: 10px 14px;
			font-size: 13px;
			color: #92400e;
			margin-bottom: 16px;
		}

		/* KPI */
		.wc-kpi-row {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
			gap: 12px;
			margin-bottom: 20px;
		}
		.wc-kpi {
			background: #fff;
			border-radius: 10px;
			padding: 16px 18px;
			display: flex;
			align-items: center;
			gap: 14px;
			box-shadow: 0 1px 4px rgba(0,0,0,.06);
		}
		.wc-kpi-icon  { font-size: 26px; line-height: 1; }
		.wc-kpi-label { font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .5px; }
		.wc-kpi-val   { font-size: 20px; font-weight: 700; margin-top: 2px; }

		/* Card + table */
		.wc-card {
			background: #fff;
			border-radius: 10px;
			box-shadow: 0 1px 4px rgba(0,0,0,.06);
			overflow: hidden;
		}
		.wc-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 13px;
		}
		.wc-table thead th {
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
		.wc-r { text-align: right !important; }

		/* Region group header */
		.wc-region-row td {
			background: #f1f5f9;
			border-top: 2px solid #cbd5e1;
			border-bottom: 1px solid #e2e8f0;
			padding: 8px 12px;
			font-size: 12px;
			color: #475569;
		}
		.wc-region-meta   { margin-left: 10px; color: #94a3b8; font-weight: normal; }
		.wc-region-weight { color: #059669; font-size: 13px; }
		.wc-region-value  { color: #64748b; font-size: 12px; }

		/* Data rows */
		.wc-row td {
			padding: 10px 12px;
			border-bottom: 1px solid #f1f5f9;
			vertical-align: middle;
			color: #334155;
		}
		.wc-row:last-child td { border-bottom: none; }
		.wc-row:hover td { background: #f8fafc; }

		/* Grand total row */
		.wc-total-row td {
			background: #1e293b;
			color: #e2e8f0;
			padding: 11px 12px;
			font-size: 13px;
		}

		.wc-link { color: #3b82f6; font-weight: 600; text-decoration: none; }
		.wc-link:hover { text-decoration: underline; }
		.wc-customer { max-width: 180px; }
		.wc-date  { white-space: nowrap; color: #64748b; }
		.wc-owner { color: #64748b; font-size: 12px; }
		.wc-weight { font-weight: 600; font-family: monospace; color: #059669; }
		.wc-zero   { color: #cbd5e1 !important; font-weight: normal !important; }
		.wc-amount { font-weight: 600; font-family: monospace; }
		.wc-na { color: #cbd5e1; }

		.wc-region-tag {
			display: inline-block;
			padding: 2px 8px;
			background: #e0f2fe;
			border-radius: 4px;
			font-size: 11px;
			font-weight: 600;
			color: #0369a1;
		}

		.wc-badge {
			display: inline-block;
			padding: 3px 10px;
			border-radius: 20px;
			font-size: 11px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: .4px;
		}
		.wc-badge-ready { background: #dcfce7; color: #166534; }
		</style>`;
	}
}
