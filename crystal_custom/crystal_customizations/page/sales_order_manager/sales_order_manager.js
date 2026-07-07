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
		this.doc_cache  = {};
		this.current_page = 1;
		this.page_size = 50;
		this.search_term = '';
		this._sps = new Set();
		this.setup_page();
		this.load_data();
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	setup_page() {
		const today = frappe.datetime.get_today();

		this.page.add_field({
			label: 'From Date', fieldtype: 'Date', fieldname: 'from_date',
			default: frappe.datetime.add_days(today, -30),
			change: () => { this.current_page = 1; this.load_data(); },
		});
		this.page.add_field({
			label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
			default: today,
			change: () => { this.current_page = 1; this.load_data(); },
		});
		this.page.add_field({
			label: 'Region', fieldtype: 'Link', fieldname: 'delivery_region',
			options: 'Delivery Region',
			change: () => { this.current_page = 1; this.load_data(); },
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
			label: 'Search', fieldtype: 'Data', fieldname: 'search_query',
			placeholder: 'Customer or order no…',
			change: () => {
				this.search_term = this.page.fields_dict.search_query.get_value() || '';
				this.current_page = 1;
				this.render();
			},
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
		this.item_cache = {};
		this.doc_cache  = {};
		this.$wrap.html(this._spinner());

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_manager.sales_order_manager.get_orders',
			args: {
				sales_persons_json: this._sps.size ? JSON.stringify([...this._sps]) : null,
				from_date:          this.page.fields_dict.from_date.get_value()        || null,
				to_date:            this.page.fields_dict.to_date.get_value()           || null,
				delivery_region:    this.page.fields_dict.delivery_region.get_value()   || null,
			},
			callback: (r) => {
				this.orders = r.message || [];
				this.current_page = 1;
				this.render();
			},
		});
	}

	filtered_orders() {
		return this.orders.filter(o => {
			if (this.search_term) {
				const q = this.search_term.toLowerCase();
				const match =
					(o.name          || '').toLowerCase().includes(q) ||
					(o.customer_name || '').toLowerCase().includes(q) ||
					(o.customer      || '').toLowerCase().includes(q) ||
					(o.sales_persons || '').toLowerCase().includes(q);
				if (!match) return false;
			}
			return true;
		});
	}

	// ── Render ────────────────────────────────────────────────────────────────

	render() {
		const all_filtered = this.filtered_orders();

		if (!all_filtered.length) {
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

		const total_pages = Math.ceil(all_filtered.length / this.page_size);
		if (this.current_page > total_pages) this.current_page = total_pages;
		const orders = all_filtered.slice(
			(this.current_page - 1) * this.page_size,
			this.current_page * this.page_size
		);

		const total_val  = all_filtered.reduce((s, o) => s + o.grand_total, 0);
		const selectable = all_filtered.length;

		let html = `
		${this._styles()}
		<div class="som-kpi-row">
			${this._kpi('Orders Ready', selectable,                   '#3b82f6', '📦')}
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
					${all_filtered.length} order${all_filtered.length !== 1 ? 's' : ''}
					${this.orders.length !== all_filtered.length ? ` (filtered from ${this.orders.length})` : ''}
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
						<th>Pre-Fulfilment</th>
					</tr>
				</thead>
				<tbody>`;

		orders.forEach(o => {
			const rejected    = !!o.custom_finance_rejection_note;
			const has_paint   = !!o.custom_paint_notes;
			const checked     = this.selected.has(o.name);
			const expanded    = this.expanded.has(o.name);
			const is_pf       = o.custom_is_pre_fulfillment == 1;

			html += `
				<tr class="som-row ${rejected ? 'som-row-rejected' : ''} ${checked ? 'som-row-selected' : ''}${is_pf ? ' som-row-pf' : ''}"
				    data-order="${o.name}">
					<td class="som-td-chk">
						<input type="checkbox" class="som-chk" data-order="${o.name}"
						       ${checked ? 'checked' : ''}>
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
						${has_paint ? `<span class="som-paint-warn" title="${frappe.utils.escape_html(o.custom_paint_notes)}">&#9888; Paint Note</span>` : ''}
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
						${rejected
							? `<span class="som-badge som-badge-rejected">Finance Rejected</span>
							   <div class="som-rejection-preview">${frappe.utils.escape_html((o.custom_finance_rejection_note || '').slice(0, 80))}${(o.custom_finance_rejection_note || '').length > 80 ? '…' : ''}</div>`
							: '<span class="som-badge som-badge-ready">Ready</span>'}
					</td>
					<td style="text-align:center;">
						<button class="btn btn-xs som-pf-btn"
						        data-order="${o.name}" data-pf="${is_pf ? 1 : 0}"
						        title="${is_pf ? 'Pre-Fulfilment — click to remove' : 'Mark as Pre-Fulfilment'}"
						        style="${is_pf ? 'background:#0d9488;color:#fff;border-color:#0d9488;' : 'background:#f1f5f9;color:#64748b;border-color:#cbd5e1;'}">
							${is_pf ? '&#128205; On' : 'Off'}
						</button>
					</td>
				</tr>`;

			if (expanded) {
				const rejection_note  = o.custom_finance_rejection_note;
				const additional_info = o.custom_additional_information;
				const paint_notes     = o.custom_paint_notes || '';
				html += `
				<tr class="som-items-row" data-order="${o.name}">
					<td colspan="10">
						<div class="som-items-wrap">
							${rejection_note ? `
							<div class="som-rejection-alert">
								<strong>⚠ Finance Rejection Note:</strong>
								${frappe.utils.escape_html(rejection_note)}
							</div>` : ''}
							<div class="som-paint-notes-editor">
								<div class="som-paint-notes-label">
									&#127758; Paint / Colour Notes
									<span style="font-size:11px;color:#92400e;font-weight:400;">(visible to production &amp; all pages)</span>
								</div>
								<textarea class="som-paint-notes-input" data-order="${o.name}"
								          rows="3" placeholder="Enter colour specs, paint codes, mixing instructions…">${frappe.utils.escape_html(paint_notes)}</textarea>
								<div style="display:flex;gap:8px;margin-top:6px;">
									<button class="btn btn-xs btn-warning som-save-paint-btn" data-order="${o.name}">Save Paint Notes</button>
									${paint_notes ? `<button class="btn btn-xs btn-default som-clear-paint-btn" data-order="${o.name}">Clear</button>` : ''}
								</div>
							</div>
							${additional_info ? `
							<div class="som-info-note">
								<strong>Additional Information:</strong>
								${frappe.utils.escape_html(additional_info)}
							</div>` : ''}
							<div id="som-items-${o.name}">
								${this._render_items(o.name)}
							</div>
						</div>
					</td>
				</tr>`;
			}
		});

		html += `</tbody></table>
			${this._pagination_html(all_filtered.length)}
		</div>`;
		this.$wrap.html(html);
		this._attach_events();
	}

	_pagination_html(total) {
		if (total <= this.page_size) return '';
		const total_pages = Math.ceil(total / this.page_size);
		const start = (this.current_page - 1) * this.page_size + 1;
		const end   = Math.min(this.current_page * this.page_size, total);
		return `<div class="som-pg-bar">
			<button class="btn btn-xs btn-default som-pg-prev" ${this.current_page <= 1 ? 'disabled' : ''}>&lsaquo; Prev</button>
			<span class="som-pg-info">Showing ${start}–${end} of ${total} &nbsp;·&nbsp; Page ${this.current_page} of ${total_pages}</span>
			<button class="btn btn-xs btn-default som-pg-next" ${this.current_page >= total_pages ? 'disabled' : ''}>Next &rsaquo;</button>
		</div>`;
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
				<th class="som-th-r">Rate</th>
				<th class="som-th-r">Wt / Unit (kg)</th>
				<th class="som-th-r">Amount</th>
				<th class="som-th-r">Total Wt</th>
			</tr></thead><tbody>`;

		items.forEach((item, idx) => {
			const amount       = (item.qty || 0) * (item.rate || 0);
			const total_weight = (item.qty || 0) * (item.weight_per_unit || 0);
			html += `<tr>
				<td><strong>${frappe.utils.escape_html(item.item_code)}</strong></td>
				<td class="som-item-name">${frappe.utils.escape_html(item.item_name || '')}</td>
				<td class="som-th-r">
					<input type="number" class="som-edit-input"
					       data-order="${order_name}" data-idx="${idx}" data-field="qty"
					       value="${item.qty || 0}" min="0" step="0.001">
				</td>
				<td>${frappe.utils.escape_html(item.uom || '')}</td>
				<td class="som-th-r">
					<input type="number" class="som-edit-input"
					       data-order="${order_name}" data-idx="${idx}" data-field="rate"
					       value="${item.rate || 0}" min="0" step="0.01">
				</td>
				<td class="som-th-r">
					<input type="number" class="som-edit-input"
					       data-order="${order_name}" data-idx="${idx}" data-field="weight_per_unit"
					       value="${item.weight_per_unit || 0}" min="0" step="0.001">
				</td>
				<td class="som-th-r">
					<span class="som-item-amount"><strong>${format_currency(amount)}</strong></span>
				</td>
				<td class="som-th-r">
					<span class="som-item-total-wt">${total_weight.toFixed(3)}</span>
				</td>
			</tr>`;
		});

		html += `</tbody></table>
		<div class="som-items-footer">
			<button class="btn btn-sm btn-primary som-save-items" data-order="${order_name}">
				Save Changes
			</button>
			<button class="btn btn-sm btn-default som-discard-items" data-order="${order_name}">
				Discard
			</button>
		</div>`;
		return html;
	}

	_fetch_items(order_name) {
		frappe.call({
			method: 'frappe.client.get',
			args: { doctype: 'Sales Order', name: order_name },
			callback: (r) => {
				if (r.message) {
					this.doc_cache[order_name]  = r.message;
					this.item_cache[order_name] = r.message.items || [];
					const $wrap = $(`#som-items-${order_name}`);
					if ($wrap.length) $wrap.html(this._render_items(order_name));
				}
			},
		});
	}

	_save_order_items(order_name) {
		const doc = this.doc_cache[order_name];
		if (!doc) { frappe.msgprint(__('Document not loaded — please collapse and re-expand the row.')); return; }

		const edited = this.item_cache[order_name] || [];
		edited.forEach((item, idx) => {
			if (doc.items[idx]) {
				doc.items[idx].qty             = item.qty;
				doc.items[idx].rate            = item.rate;
				doc.items[idx].weight_per_unit = item.weight_per_unit;
			}
		});

		frappe.call({
			method: 'frappe.client.save',
			args: { doc },
			freeze: true,
			freeze_message: __('Saving {0}…', [order_name]),
			callback: (r) => {
				if (!r.message) return;
				this.doc_cache[order_name]  = r.message;
				this.item_cache[order_name] = r.message.items || [];

				// Update totals in the orders array so they reflect in the main table
				const order = this.orders.find(o => o.name === order_name);
				if (order) {
					order.grand_total      = r.message.grand_total;
					order.total_net_weight = r.message.total_net_weight;
				}

				frappe.show_alert({ message: __('Saved {0}', [order_name]), indicator: 'green' });

				// Refresh just the items section
				const $wrap = $(`#som-items-${order_name}`);
				if ($wrap.length) $wrap.html(this._render_items(order_name));

				// Update the amount cell in the parent row without a full re-render
				this.$wrap.find(`tr.som-row[data-order="${order_name}"] .som-amount`)
					.text(format_currency(r.message.grand_total));
			},
			error: (err) => {
				frappe.msgprint({
					title: __('Save Failed'),
					message: frappe.utils.escape_html(
						(err._server_messages && JSON.parse(err._server_messages)[0]) ||
						err.message || __('Could not save {0}', [order_name])
					),
					indicator: 'red',
				});
			},
		});
	}

	// ── Events ────────────────────────────────────────────────────────────────

	_attach_events() {
		const self = this;

		// Select all
		this.$wrap.find('#som-select-all').on('change', function () {
			const checked = $(this).is(':checked');
			self.$wrap.find('.som-chk').prop('checked', checked);
			self.filtered_orders().forEach(o => {
				checked ? self.selected.add(o.name) : self.selected.delete(o.name);
			});
			self.render();
		});

		// Individual checkbox — update in-place without full re-render
		this.$wrap.find('.som-chk').on('change', function () {
			const name = $(this).data('order');
			$(this).is(':checked') ? self.selected.add(name) : self.selected.delete(name);
			// update KPI count in place
			self.$wrap.find('.som-kpi-row .som-kpi-val').eq(2).text(self.selected.size);
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

		// Save paint notes
		this.$wrap.find('.som-save-paint-btn').on('click', function () {
			const name  = $(this).data('order');
			const notes = self.$wrap.find(`.som-paint-notes-input[data-order="${name}"]`).val().trim();
			frappe.db.set_value('Sales Order', name, 'custom_paint_notes', notes).then(() => {
				// Update local cache
				const o = self.orders.find(x => x.name === name);
				if (o) o.custom_paint_notes = notes;
				frappe.show_alert({ message: __('Paint notes saved for {0}', [name]), indicator: 'green' });
				// Refresh badge on the order row without full re-render
				const $row = self.$wrap.find(`.som-row[data-order="${name}"] td:nth-child(3)`);
				if (notes) {
					if (!$row.find('.som-paint-warn').length) {
						$row.append(`<span class="som-paint-warn" title="${frappe.utils.escape_html(notes)}">&#9888; Paint Note</span>`);
					} else {
						$row.find('.som-paint-warn').attr('title', frappe.utils.escape_html(notes));
					}
				} else {
					$row.find('.som-paint-warn').remove();
				}
			});
		});

		// Clear paint notes
		this.$wrap.find('.som-clear-paint-btn').on('click', function () {
			const name = $(this).data('order');
			self.$wrap.find(`.som-paint-notes-input[data-order="${name}"]`).val('');
			$(this).hide();
		});

		// Pagination
		this.$wrap.find('.som-pg-prev').on('click', () => {
			if (this.current_page > 1) { this.current_page--; this.render(); }
		});
		this.$wrap.find('.som-pg-next').on('click', () => {
			const tp = Math.ceil(this.filtered_orders().length / this.page_size);
			if (this.current_page < tp) { this.current_page++; this.render(); }
		});

		// Item editing — delegated so they work after async fetch
		this.$wrap.off('input.som-edit').on('input.som-edit', '.som-edit-input', function () {
			const order_name = $(this).data('order');
			const idx        = parseInt($(this).data('idx'));
			const field      = $(this).data('field');
			const value      = parseFloat($(this).val()) || 0;

			const items = self.item_cache[order_name];
			if (!items || !items[idx]) return;
			items[idx][field] = value;

			const item         = items[idx];
			const amount       = (item.qty || 0) * (item.rate || 0);
			const total_weight = (item.qty || 0) * (item.weight_per_unit || 0);
			const $row         = $(this).closest('tr');
			$row.find('.som-item-amount').html(`<strong>${format_currency(amount)}</strong>`);
			$row.find('.som-item-total-wt').text(total_weight.toFixed(3));
		});

		this.$wrap.off('click.som-save').on('click.som-save', '.som-save-items', function () {
			self._save_order_items($(this).data('order'));
		});

		this.$wrap.off('click.som-discard').on('click.som-discard', '.som-discard-items', function () {
			const order_name = $(this).data('order');
			delete self.item_cache[order_name];
			delete self.doc_cache[order_name];
			const $wrap = $(`#som-items-${order_name}`);
			if ($wrap.length) $wrap.html(self._render_items(order_name));
		});

		// Pre-Fulfilment toggle
		this.$wrap.off('click.som-pf').on('click.som-pf', '.som-pf-btn', function () {
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
						$btn.closest('tr').addClass('som-row-pf');
					} else {
						$btn.css({ background: '#f1f5f9', color: '#64748b', 'border-color': '#cbd5e1' })
						    .attr('title', 'Mark as Pre-Fulfilment')
						    .html('Off');
						$btn.closest('tr').removeClass('som-row-pf');
					}
					frappe.show_alert({
						message: new_val ? __('Marked as Pre-Fulfilment') : __('Pre-Fulfilment removed'),
						indicator: new_val ? 'green' : 'blue',
					});
				},
			});
		});
	}

	// ── Submit ────────────────────────────────────────────────────────────────

	submit_selected() {
		const list = Array.from(this.selected);
		if (!list.length) { frappe.msgprint(__('Select at least one order.')); return; }

		// Identify which selected orders were previously rejected
		const resubmissions = list.filter(name => {
			const o = this.orders.find(x => x.name === name);
			return o && !!o.custom_finance_rejection_note;
		});

		if (resubmissions.length) {
			frappe.prompt(
				[{
					label: 'Resubmission Note',
					fieldname: 'note',
					fieldtype: 'Small Text',
					reqd: 1,
					description: __(`{0} of the selected order(s) were previously rejected by Finance.
Add a note explaining what has changed — Finance will see this alongside the original rejection reason.`, [resubmissions.length]),
				}],
				(vals) => {
					frappe.confirm(
						__('Send {0} order(s) to Finance? ({1} resubmission(s))', [list.length, resubmissions.length]),
						() => this._process(list, vals.note, resubmissions)
					);
				},
				__('Resubmission Note'), __('Continue')
			);
		} else {
			frappe.confirm(
				__('Send {0} order(s) to Finance for approval?', [list.length]),
				() => this._process(list, '', [])
			);
		}
	}

	_process(list, resubmission_note, resubmissions) {
		frappe.show_alert({ message: __('Sending to Finance…'), indicator: 'blue' });

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_manager.sales_order_manager.send_to_finance',
			args: {
				order_names: JSON.stringify(list),
				resubmission_note: resubmission_note || '',
				resubmission_orders: JSON.stringify(resubmissions || []),
			},
			callback: (r) => {
				const result  = r.message || {};
				const updated = result.updated || [];
				const skipped = result.skipped || [];

				if (updated.length) {
					// Notify finance users of the new pending orders
					frappe.call({
						method: 'crystal_custom.crystal_customizations.page.sales_order_manager.sales_order_manager.notify_finance_of_new_orders',
						args: { order_names: JSON.stringify(updated) },
					});
				}

				if (skipped.length) {
					frappe.msgprint({
						title: __('Some orders skipped'),
						message: __('Sent {0} orders. Skipped {1} (wrong state or already processed): {2}',
							[updated.length, skipped.length, skipped.join(', ')]),
						indicator: 'orange',
					});
				} else {
					frappe.show_alert({
						message: __('✓ {0} orders sent to Finance', [updated.length]),
						indicator: 'green',
					});
				}
				this.selected.clear();
				this.load_data();
			},
			error: () => {
				frappe.msgprint({ title: __('Error'), message: __('Failed to send orders to Finance'), indicator: 'red' });
			},
		});
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
		.som-row-rejected td { background: #fff5f5; border-left: 3px solid #ef4444 !important; }
		.som-row-pf td { background: #f0fdfa !important; }
		.som-row-pf:hover td { background: #ccfbf1 !important; }

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
		.som-badge-ready    { background:#dcfce7; color:#166534; }
		.som-badge-rejected { background:#fee2e2; color:#991b1b; }

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
		.som-edit-input {
			width: 88px;
			height: 26px;
			padding: 2px 6px;
			font-size: 12px;
			text-align: right;
			border: 1px solid #cbd5e1;
			border-radius: 4px;
			background: #fff;
			transition: border-color .15s, box-shadow .15s;
		}
		.som-edit-input:focus {
			outline: none;
			border-color: #3b82f6;
			box-shadow: 0 0 0 2px rgba(59,130,246,.15);
		}
		.som-items-footer {
			display: flex;
			gap: 8px;
			padding: 10px 0 2px;
			border-top: 1px solid #e2e8f0;
			margin-top: 8px;
		}
		.som-rejection-preview {
			font-size: 11px;
			color: #991b1b;
			font-style: italic;
			margin-top: 3px;
			line-height: 1.4;
		}
		.som-rejection-alert {
			background: #fff5f5;
			border: 1px solid #fca5a5;
			border-left: 4px solid #ef4444;
			border-radius: 4px;
			padding: 10px 14px;
			font-size: 13px;
			color: #7f1d1d;
			margin-bottom: 12px;
		}
		.som-info-note {
			background: #f0f9ff;
			border: 1px solid #bae6fd;
			border-left: 4px solid #3b82f6;
			border-radius: 4px;
			padding: 10px 14px;
			font-size: 13px;
			color: #1e3a5f;
			margin-bottom: 12px;
		}

		/* Paint notes */
		.som-paint-warn {
			display: inline-block;
			margin-left: 8px;
			font-size: 10px;
			font-weight: 700;
			background: #fef3c7;
			color: #92400e;
			border: 1px solid #fcd34d;
			border-radius: 10px;
			padding: 1px 7px;
			cursor: default;
			white-space: nowrap;
		}
		.som-paint-notes-editor {
			background: #fffbeb;
			border: 1px solid #fcd34d;
			border-left: 4px solid #f59e0b;
			border-radius: 6px;
			padding: 12px 16px;
			margin-bottom: 12px;
		}
		.som-paint-notes-label {
			font-size: 12px;
			font-weight: 700;
			color: #92400e;
			margin-bottom: 8px;
		}
		.som-paint-notes-input {
			width: 100%;
			border: 1px solid #fcd34d;
			border-radius: 4px;
			padding: 8px 10px;
			font-size: 13px;
			background: #fff;
			resize: vertical;
			font-family: inherit;
		}
		.som-paint-notes-input:focus { outline: none; border-color: #f59e0b; box-shadow: 0 0 0 2px #fef3c7; }

		/* Pagination */
		.som-pg-bar {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 14px;
			padding: 12px 16px;
			border-top: 1px solid #f1f5f9;
			background: #f8fafc;
		}
		.som-pg-info { font-size: 13px; color: #64748b; }
		.som-pg-bar .btn { min-width: 70px; }
		</style>`;
	}
}
