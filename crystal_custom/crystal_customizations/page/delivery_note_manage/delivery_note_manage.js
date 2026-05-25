frappe.pages['delivery-note-manage'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Delivery Note Manager',
		single_column: true
	});
	new DeliveryNoteManager(page);
}

class DeliveryNoteManager {
    constructor(page) {
        this.page = page;
        this.filters = { regions: [], customer: null };
        this.orders = [];
        this.delivery_notes = [];
        this.invoices = [];
        this.active_tab = 'pending';
        this.page_size = 50;
        this.orders_page = 1;
        this.dns_page = 1;
        this.invoices_page = 1;
        this.setup_page();
        this.set_default_dates();
        this.load_data();
    }

    setup_page() {
        this.page.add_field({
            label: 'From Date',
            fieldtype: 'Date',
            fieldname: 'from_date',
            change: () => this.load_data()
        });

        this.page.add_field({
            label: 'To Date',
            fieldtype: 'Date',
            fieldname: 'to_date',
            change: () => this.load_data()
        });

        this.page.add_field({
            label: 'Delivery Region',
            fieldtype: 'Link',
            fieldname: 'delivery_region',
            options: 'Delivery Region',
            change: () => this.apply_filters()
        });

        this.page.add_field({
            label: 'Customer',
            fieldtype: 'Link',
            fieldname: 'customer',
            options: 'Customer',
            change: () => this.apply_filters()
        });

        this.page.add_field({
            label: 'Sales Person',
            fieldtype: 'Link',
            fieldname: 'sales_person',
            options: 'Sales Person',
            change: () => { this.orders_page = 1; this.dns_page = 1; this.invoices_page = 1; this.load_data(); }
        });

        this.page.add_button('Refresh', () => {
            this.load_data();
        }, 'octicon octicon-sync');

        this.container = $('<div class="delivery-manager-container"></div>').appendTo(this.page.main);

        this.container.html(`
            <div class="dm-tabs" style="margin-top: 20px;">
                <button class="dm-tab-btn active" data-tab="pending">Pending Delivery</button>
                <button class="dm-tab-btn" data-tab="dns">Submitted Delivery Notes</button>
                <button class="dm-tab-btn" data-tab="invoices">Sales Invoices</button>
            </div>
            <div class="dm-tab-content">
                <div class="dm-tab-pane active" id="dm-tab-pending"></div>
                <div class="dm-tab-pane" id="dm-tab-dns"></div>
                <div class="dm-tab-pane" id="dm-tab-invoices"></div>
            </div>
            <style>
                .dm-tabs {
                    display: flex;
                    border-bottom: 2px solid #667eea;
                    gap: 4px;
                }
                .dm-tab-btn {
                    background: none;
                    border: none;
                    border-bottom: 3px solid transparent;
                    margin-bottom: -2px;
                    padding: 10px 20px;
                    font-weight: 600;
                    font-size: 14px;
                    color: #6b7280;
                    cursor: pointer;
                    transition: color 0.2s;
                    outline: none;
                }
                .dm-tab-btn:hover { color: #667eea; }
                .dm-tab-btn.active {
                    color: #667eea;
                    border-bottom: 3px solid #667eea;
                }
                .dm-tab-pane { display: none; padding-top: 20px; }
                .dm-tab-pane.active { display: block; }
            </style>
        `);

        this.container.find('.dm-tab-btn').on('click', (e) => {
            const tab = $(e.currentTarget).data('tab');
            this.container.find('.dm-tab-btn').removeClass('active');
            $(e.currentTarget).addClass('active');
            this.container.find('.dm-tab-pane').removeClass('active');
            $(`#dm-tab-${tab}`).addClass('active');
            this.active_tab = tab;
            if (tab === 'dns' && this.delivery_notes.length === 0) {
                this.load_delivery_notes();
            } else if (tab === 'invoices') {
                this.load_sales_invoices();
            }
        });
    }

    set_default_dates() {
        const today = frappe.datetime.get_today();
        const yesterday = frappe.datetime.add_days(today, -1);
        this.page.fields_dict.from_date.set_value(yesterday);
        this.page.fields_dict.to_date.set_value(today);
    }

    load_data() {
        // Clear all caches on date change
        this.orders = [];
        this.delivery_notes = [];
        this.invoices = [];

        if (this.active_tab === 'pending') {
            this.load_pending_orders();
        } else if (this.active_tab === 'dns') {
            this.load_delivery_notes();
        } else if (this.active_tab === 'invoices') {
            this.load_sales_invoices();
        }
    }

    load_pending_orders() {
        const from_date = this.page.fields_dict.from_date.get_value();
        const to_date = this.page.fields_dict.to_date.get_value();

        if (!from_date || !to_date) {
            frappe.msgprint(__('Please select both From Date and To Date'));
            return;
        }

        $('#dm-tab-pending').html(this.loading_html('orders'));

        const sp_orders = this.page.fields_dict.sales_person.get_value();
        const so_filters = [
            ['Sales Order', 'docstatus', '=', 1],
            ['Sales Order', 'transaction_date', 'between', [from_date, to_date]],
            ['Sales Order', 'per_delivered', '<', 100],
            ['Sales Order', 'status', '!=', 'Closed']
        ];
        if (sp_orders) so_filters.push(['Sales Team', 'sales_person', '=', sp_orders]);

        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Sales Order',
                fields: ['name', 'customer', 'customer_name', 'transaction_date', 'grand_total',
                         'custom_delivery_region', 'custom_phone_number', 'delivery_date', 'per_delivered', 'status'],
                filters: so_filters,
                order_by: 'transaction_date desc',
                limit_page_length: 500
            },
            callback: (r) => {
                this.orders = r.message || [];
                this.render_pending_orders();
            },
            error: () => {
                this.orders = [];
                this.render_pending_orders();
            }
        });
    }

    load_delivery_notes() {
        const from_date = this.page.fields_dict.from_date.get_value();
        const to_date = this.page.fields_dict.to_date.get_value();

        if (!from_date || !to_date) return;

        $('#dm-tab-dns').html(this.loading_html('delivery notes'));

        const sp_dn = this.page.fields_dict.sales_person.get_value();
        const dn_filters = [
            ['Delivery Note', 'docstatus', '=', 1],
            ['Delivery Note', 'posting_date', 'between', [from_date, to_date]]
        ];
        if (sp_dn) dn_filters.push(['Sales Team', 'sales_person', '=', sp_dn]);

        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Delivery Note',
                fields: ['name', 'customer', 'customer_name', 'posting_date', 'grand_total',
                         'per_billed', 'status', 'custom_delivery_region'],
                filters: dn_filters,
                order_by: 'posting_date desc',
                limit_page_length: 500
            },
            callback: (r) => {
                this.delivery_notes = r.message || [];
                this.render_delivery_notes();
            },
            error: () => {
                this.delivery_notes = [];
                this.render_delivery_notes();
            }
        });
    }

    load_sales_invoices() {
        const from_date = this.page.fields_dict.from_date.get_value();
        const to_date = this.page.fields_dict.to_date.get_value();

        if (!from_date || !to_date) return;

        $('#dm-tab-invoices').html(this.loading_html('sales invoices'));

        const sp_inv = this.page.fields_dict.sales_person.get_value();
        const inv_filters = [
            ['Sales Invoice', 'docstatus', '!=', 2],
            ['Sales Invoice', 'posting_date', 'between', [from_date, to_date]],
            ['Sales Invoice Item', 'delivery_note', '!=', '']
        ];
        if (sp_inv) inv_filters.push(['Sales Team', 'sales_person', '=', sp_inv]);

        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Sales Invoice',
                fields: ['name', 'customer', 'customer_name', 'posting_date', 'grand_total',
                         'outstanding_amount', 'status', 'docstatus'],
                filters: inv_filters,
                order_by: 'posting_date desc',
                limit_page_length: 500
            },
            callback: (r) => {
                this.invoices = r.message || [];
                this.render_sales_invoices();
            },
            error: () => {
                this.invoices = [];
                this.render_sales_invoices();
            }
        });
    }

    apply_filters() {
        const regions = this.page.fields_dict.delivery_region.get_value();
        const customer = this.page.fields_dict.customer.get_value();
        this.filters = {
            regions: regions ? [regions] : [],
            customer: customer
        };
        this.orders_page = 1;
        this.dns_page = 1;
        this.invoices_page = 1;

        if (this.active_tab === 'pending') {
            this.render_pending_orders();
        } else if (this.active_tab === 'dns') {
            this.render_delivery_notes();
        } else if (this.active_tab === 'invoices') {
            this.render_sales_invoices();
        }
    }

    get_filtered_orders() {
        return this.orders.filter(order => {
            if (this.filters.customer && order.customer !== this.filters.customer) return false;
            if (this.filters.regions && this.filters.regions.length > 0 &&
                !this.filters.regions.includes(order.custom_delivery_region)) return false;
            return true;
        });
    }

    get_filtered_delivery_notes() {
        return this.delivery_notes.filter(dn => {
            if (this.filters.customer && dn.customer !== this.filters.customer) return false;
            if (this.filters.regions && this.filters.regions.length > 0 &&
                !this.filters.regions.includes(dn.custom_delivery_region)) return false;
            return true;
        });
    }

    get_filtered_invoices() {
        return this.invoices.filter(inv => {
            if (this.filters.customer && inv.customer !== this.filters.customer) return false;
            return true;
        });
    }

    loading_html(label) {
        return `
            <div style="text-align: center; padding: 50px;">
                <div class="spinner-border text-primary" role="status"></div>
                <p style="margin-top: 15px; color: #6b7280;">Loading ${label}...</p>
            </div>
        `;
    }

    // ─── Tab 1: Pending Delivery ──────────────────────────────────────────────

    render_pending_orders() {
        const all_filtered = this.get_filtered_orders();
        const $tab = $('#dm-tab-pending');
        const total_pages = Math.ceil(all_filtered.length / this.page_size) || 1;
        if (this.orders_page > total_pages) this.orders_page = total_pages;
        const filtered = all_filtered.slice(
            (this.orders_page - 1) * this.page_size,
            this.orders_page * this.page_size
        );

        if (all_filtered.length === 0) {
            $tab.html(`
                <div class="alert alert-info" style="margin-top: 20px;">
                    <strong>No orders found</strong><br>
                    ${this.orders.length > 0 ?
                        'No orders match your filters.' :
                        'No submitted sales orders without delivery notes in the selected date range.'}
                </div>
            `);
            return;
        }

        const total_value = all_filtered.reduce((sum, o) => sum + o.grand_total, 0);
        const regions = [...new Set(all_filtered.map(o => o.custom_delivery_region).filter(r => r))];

        let html = `
            <div class="delivery-orders-table">
                ${this.summary_cards([
                    { label: 'Pending Delivery', value: filtered.length, color: '#667eea, #764ba2' },
                    { label: 'Total Value', value: format_currency(total_value), color: '#43e97b, #38f9d7' },
                    { label: 'Regions', value: regions.length, color: '#f093fb, #f5576c' }
                ])}
                <div class="table-wrapper">
                    <table class="table table-bordered modern-table">
                        <thead>
                            <tr>
                                <th width="5%"></th>
                                <th width="12%">Sales Order</th>
                                <th width="15%">Customer</th>
                                <th width="12%">Phone</th>
                                <th width="10%">Amount</th>
                                <th width="10%">Order Date</th>
                                <th width="10%">Delivery Date</th>
                                <th width="12%">Region</th>
                                <th width="14%">Action</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        filtered.forEach(order => {
            const delivery_date = order.delivery_date || order.transaction_date;
            const is_overdue = delivery_date && frappe.datetime.get_diff(frappe.datetime.get_today(), delivery_date) > 0;

            html += `
                <tr class="order-row ${is_overdue ? 'order-overdue' : ''}" data-order="${order.name}">
                    <td><span class="toggle-details" style="cursor:pointer; font-size:16px;">▶</span></td>
                    <td><a href="/app/sales-order/${order.name}" target="_blank" class="order-link">${order.name}</a></td>
                    <td><a href="/app/customer/${order.customer}" target="_blank" class="customer-link">${order.customer_name || order.customer}</a></td>
                    <td>
                        ${order.custom_phone_number ?
                            `<a href="tel:${order.custom_phone_number}" class="phone-link">${order.custom_phone_number}</a>` :
                            '<span class="text-muted">-</span>'}
                    </td>
                    <td><span class="amount-badge">${format_currency(order.grand_total)}</span></td>
                    <td>${frappe.datetime.str_to_user(order.transaction_date)}</td>
                    <td>
                        ${delivery_date ?
                            `<span class="${is_overdue ? 'date-overdue' : 'date-normal'}">${frappe.datetime.str_to_user(delivery_date)}</span>` :
                            '<span class="text-muted">-</span>'}
                        ${is_overdue ? '<span class="overdue-badge">OVERDUE</span>' : ''}
                    </td>
                    <td><span class="region-tag">${order.custom_delivery_region || '-'}</span></td>
                    <td>
                        <button class="btn btn-sm btn-primary btn-create-dn" data-order="${order.name}">
                            Create Delivery Note
                        </button>
                    </td>
                </tr>
                <tr class="order-details-row" data-order="${order.name}" style="display:none;">
                    <td colspan="9">
                        <div class="order-details-container" style="padding:15px; background:#f8f9fa;">
                            <div class="loading">Loading items...</div>
                        </div>
                    </td>
                </tr>
            `;
        });

        html += `</tbody></table>
        ${this._pagination_html(all_filtered.length, 'orders_page', '#dm-tab-pending', () => this.render_pending_orders())}
        </div></div>${this.shared_styles()}`;
        $tab.html(html);
        this.attach_pending_events();
        this._attach_pagination_events('#dm-tab-pending', 'orders_page', all_filtered.length, () => this.render_pending_orders());
    }

    attach_pending_events() {
        const self = this;

        $('#dm-tab-pending').find('.toggle-details').off('click').on('click', function(e) {
            e.stopPropagation();
            const $icon = $(this);
            const order_name = $icon.closest('tr').data('order');
            const $details_row = $(`#dm-tab-pending .order-details-row[data-order="${order_name}"]`);
            if ($details_row.is(':visible')) {
                $details_row.hide();
                $icon.text('▶');
            } else {
                $details_row.show();
                $icon.text('▼');
                self.load_order_items(order_name);
            }
        });

        $('#dm-tab-pending').find('.btn-create-dn').off('click').on('click', function() {
            self.create_delivery_note($(this).data('order'));
        });
    }

    load_order_items(order_name) {
        const $container = $(`#dm-tab-pending .order-details-row[data-order="${order_name}"] .order-details-container`);
        frappe.call({
            method: 'frappe.client.get',
            args: { doctype: 'Sales Order', name: order_name },
            callback: (r) => {
                if (r.message) this.render_order_items($container, r.message.items);
            }
        });
    }

    render_order_items($container, items) {
        let html = '<div class="items-list">';
        items.forEach(item => {
            html += `
                <div class="item-row">
                    <div class="item-header">${item.item_code} - ${item.item_name || ''}</div>
                    <div class="item-details">
                        <span><strong>Qty:</strong> ${item.qty} ${item.uom || ''}</span>
                        <span><strong>Delivered:</strong> ${item.delivered_qty || 0} ${item.uom || ''}</span>
                        <span><strong>Pending:</strong> ${item.qty - (item.delivered_qty || 0)} ${item.uom || ''}</span>
                        <span><strong>Rate:</strong> ${format_currency(item.rate)}</span>
                        <span><strong>Amount:</strong> ${format_currency(item.amount)}</span>
                        ${item.weight_per_unit ? `<span><strong>Weight:</strong> ${item.weight_per_unit} ${item.weight_uom || 'kg'}</span>` : ''}
                    </div>
                </div>
            `;
        });
        html += '</div>';
        $container.html(html);
    }

    create_delivery_note(order_name) {
        frappe.call({
            method: 'erpnext.selling.doctype.sales_order.sales_order.make_delivery_note',
            args: { source_name: order_name },
            callback: (r) => {
                if (r.message) {
                    frappe.call({
                        method: 'frappe.client.insert',
                        args: { doc: r.message },
                        callback: (res) => {
                            frappe.show_alert({
                                message: __('Draft Delivery Note {0} created', [res.message.name]),
                                indicator: 'green'
                            });
                            frappe.set_route('Form', 'Delivery Note', res.message.name);
                        }
                    });
                }
            }
        });
    }

    // ─── Tab 2: Submitted Delivery Notes ─────────────────────────────────────

    render_delivery_notes() {
        const all_filtered = this.get_filtered_delivery_notes();
        const $tab = $('#dm-tab-dns');
        const total_pages = Math.ceil(all_filtered.length / this.page_size) || 1;
        if (this.dns_page > total_pages) this.dns_page = total_pages;
        const filtered = all_filtered.slice(
            (this.dns_page - 1) * this.page_size,
            this.dns_page * this.page_size
        );

        if (all_filtered.length === 0) {
            $tab.html(`
                <div class="alert alert-info" style="margin-top: 20px;">
                    <strong>No submitted delivery notes found</strong><br>
                    ${this.delivery_notes.length > 0 ?
                        'No delivery notes match your filters.' :
                        'No submitted delivery notes in the selected date range.'}
                </div>
            `);
            return;
        }

        const total_value = all_filtered.reduce((sum, dn) => sum + (dn.grand_total || 0), 0);
        const billed = all_filtered.filter(dn => dn.per_billed >= 100).length;
        const unbilled = all_filtered.length - billed;

        let html = `
            <div class="delivery-orders-table">
                ${this.summary_cards([
                    { label: 'Delivery Notes', value: filtered.length, color: '#667eea, #764ba2' },
                    { label: 'Total Value', value: format_currency(total_value), color: '#43e97b, #38f9d7' },
                    { label: 'Unbilled', value: unbilled, color: '#f093fb, #f5576c' }
                ])}
                <div style="margin-bottom: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                    <label style="margin: 0; display: flex; align-items: center; gap: 6px; cursor: pointer;">
                        <input type="checkbox" class="select-all-dns" style="width:16px; height:16px;">
                        <span style="font-weight:600;">Select All</span>
                    </label>
                    <button class="btn btn-sm btn-default btn-print-dns">
                        🖨 Print Selected
                    </button>
                    <button class="btn btn-sm btn-success btn-create-invoices">
                        + Create Sales Invoice for Selected
                    </button>
                </div>
                <div class="table-wrapper">
                    <table class="table table-bordered modern-table">
                        <thead>
                            <tr>
                                <th width="4%"></th>
                                <th width="14%">Delivery Note</th>
                                <th width="18%">Customer</th>
                                <th width="10%">Date</th>
                                <th width="12%">Amount</th>
                                <th width="12%">Region</th>
                                <th width="10%">Billing</th>
                                <th width="20%">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        filtered.forEach(dn => {
            const billed_pct = dn.per_billed || 0;
            const fully_billed = billed_pct >= 100;

            html += `
                <tr class="order-row" data-dn="${dn.name}">
                    <td>
                        <input type="checkbox" class="dn-checkbox" data-dn="${dn.name}"
                               style="width:16px; height:16px; cursor:pointer;">
                    </td>
                    <td><a href="/app/delivery-note/${dn.name}" target="_blank" class="order-link">${dn.name}</a></td>
                    <td><a href="/app/customer/${dn.customer}" target="_blank" class="customer-link">${dn.customer_name || dn.customer}</a></td>
                    <td>${frappe.datetime.str_to_user(dn.posting_date)}</td>
                    <td><span class="amount-badge">${format_currency(dn.grand_total)}</span></td>
                    <td><span class="region-tag">${dn.custom_delivery_region || '-'}</span></td>
                    <td>
                        <span class="badge ${fully_billed ? 'badge-success' : 'badge-warning'}" style="font-size:11px;">
                            ${fully_billed ? '✓ Billed' : `${billed_pct.toFixed(0)}% Billed`}
                        </span>
                    </td>
                    <td>
                        <button class="btn btn-xs btn-default btn-print-dn" data-dn="${dn.name}" title="Print">
                            🖨 Print
                        </button>
                        ${!fully_billed ? `
                            <button class="btn btn-xs btn-success btn-create-invoice" data-dn="${dn.name}">
                                + Create Invoice
                            </button>
                        ` : ''}
                    </td>
                </tr>
            `;
        });

        html += `</tbody></table>
        ${this._pagination_html(all_filtered.length, 'dns_page', '#dm-tab-dns', () => this.render_delivery_notes())}
        </div></div>${this.shared_styles()}`;
        $tab.html(html);
        this.attach_dns_events(filtered);
        this._attach_pagination_events('#dm-tab-dns', 'dns_page', all_filtered.length, () => this.render_delivery_notes());
    }

    attach_dns_events(filtered) {
        const $tab = $('#dm-tab-dns');
        const self = this;

        $tab.find('.select-all-dns').off('change').on('change', function() {
            $tab.find('.dn-checkbox').prop('checked', $(this).is(':checked'));
        });

        $tab.find('.btn-print-dn').off('click').on('click', function() {
            self.print_document('Delivery Note', $(this).data('dn'));
        });

        $tab.find('.btn-create-invoice').off('click').on('click', function() {
            self.create_sales_invoice($(this).data('dn'));
        });

        $tab.find('.btn-print-dns').off('click').on('click', function() {
            const selected = self.get_selected_dns();
            if (!selected.length) {
                frappe.msgprint(__('Please select at least one delivery note to print'));
                return;
            }
            selected.forEach(name => self.print_document('Delivery Note', name));
        });

        $tab.find('.btn-create-invoices').off('click').on('click', function() {
            const selected = self.get_selected_dns();
            if (!selected.length) {
                frappe.msgprint(__('Please select at least one delivery note'));
                return;
            }
            frappe.confirm(
                __('Create Sales Invoice for {0} selected delivery note(s)?', [selected.length]),
                () => self.create_invoices_for_selected(selected)
            );
        });
    }

    get_selected_dns() {
        const selected = [];
        $('#dm-tab-dns').find('.dn-checkbox:checked').each(function() {
            selected.push($(this).data('dn'));
        });
        return selected;
    }

    create_sales_invoice(dn_name) {
        frappe.call({
            method: 'erpnext.stock.doctype.delivery_note.delivery_note.make_sales_invoice',
            args: { source_name: dn_name },
            callback: (r) => {
                if (r.message) {
                    frappe.model.sync(r.message);
                    frappe.set_route('Form', 'Sales Invoice', r.message.name);
                }
            },
            error: () => {
                frappe.msgprint(__('Failed to create Sales Invoice for {0}', [dn_name]));
            }
        });
    }

    create_invoices_for_selected(dn_names) {
        let processed = 0;
        let errors = [];

        frappe.show_alert({ message: __('Creating invoices...'), indicator: 'blue' });

        const process_next = () => {
            if (processed >= dn_names.length) {
                if (errors.length) {
                    frappe.msgprint({
                        title: __('Done with errors'),
                        message: __('Created {0} invoice(s). Failed: {1}',
                            [dn_names.length - errors.length, errors.join(', ')]),
                        indicator: 'orange'
                    });
                } else {
                    frappe.show_alert({
                        message: __('Created {0} invoice(s) successfully', [dn_names.length]),
                        indicator: 'green'
                    });
                    // Reload invoices tab cache
                    this.invoices = [];
                }
                return;
            }

            frappe.call({
                method: 'erpnext.stock.doctype.delivery_note.delivery_note.make_sales_invoice',
                args: { source_name: dn_names[processed] },
                callback: (r) => {
                    if (r.message) {
                        frappe.call({
                            method: 'frappe.client.insert',
                            args: { doc: r.message },
                            callback: () => { processed++; process_next(); },
                            error: () => { errors.push(dn_names[processed]); processed++; process_next(); }
                        });
                    } else {
                        errors.push(dn_names[processed]);
                        processed++;
                        process_next();
                    }
                },
                error: () => { errors.push(dn_names[processed]); processed++; process_next(); }
            });
        };

        process_next();
    }

    print_document(doctype, name) {
        window.open(
            `/printview?doctype=${encodeURIComponent(doctype)}&name=${encodeURIComponent(name)}&trigger_print=1`,
            '_blank'
        );
    }

    // ─── Tab 3: Sales Invoices ────────────────────────────────────────────────

    render_sales_invoices() {
        const all_filtered = this.get_filtered_invoices();
        const $tab = $('#dm-tab-invoices');
        const total_pages = Math.ceil(all_filtered.length / this.page_size) || 1;
        if (this.invoices_page > total_pages) this.invoices_page = total_pages;
        const filtered = all_filtered.slice(
            (this.invoices_page - 1) * this.page_size,
            this.invoices_page * this.page_size
        );

        if (all_filtered.length === 0) {
            $tab.html(`
                <div class="alert alert-info" style="margin-top: 20px;">
                    <strong>No sales invoices found</strong><br>
                    ${this.invoices.length > 0 ?
                        'No invoices match your filters.' :
                        'No sales invoices linked to delivery notes in the selected date range.'}
                </div>
            `);
            return;
        }

        const total_value = all_filtered.reduce((sum, inv) => sum + (inv.grand_total || 0), 0);
        const total_outstanding = all_filtered.reduce((sum, inv) => sum + (inv.outstanding_amount || 0), 0);
        const paid = all_filtered.filter(inv => inv.outstanding_amount <= 0).length;

        let html = `
            <div class="delivery-orders-table">
                ${this.summary_cards([
                    { label: 'Total Invoices', value: filtered.length, color: '#667eea, #764ba2' },
                    { label: 'Total Value', value: format_currency(total_value), color: '#43e97b, #38f9d7' },
                    { label: 'Outstanding', value: format_currency(total_outstanding), color: '#f093fb, #f5576c' },
                    { label: 'Paid', value: paid, color: '#4facfe, #00f2fe' }
                ])}
                <div style="margin-bottom: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                    <label style="margin: 0; display: flex; align-items: center; gap: 6px; cursor: pointer;">
                        <input type="checkbox" class="select-all-invoices" style="width:16px; height:16px;">
                        <span style="font-weight:600;">Select All</span>
                    </label>
                    <button class="btn btn-sm btn-default btn-print-invoices">
                        🖨 Print Selected
                    </button>
                </div>
                <div class="table-wrapper">
                    <table class="table table-bordered modern-table">
                        <thead>
                            <tr>
                                <th width="4%"></th>
                                <th width="15%">Invoice</th>
                                <th width="18%">Customer</th>
                                <th width="10%">Date</th>
                                <th width="13%">Amount</th>
                                <th width="13%">Outstanding</th>
                                <th width="12%">Status</th>
                                <th width="15%">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        filtered.forEach(inv => {
            const status_color = {
                'Paid': 'badge-success',
                'Unpaid': 'badge-warning',
                'Overdue': 'badge-danger',
                'Partly Paid': 'badge-info'
            }[inv.status] || 'badge-default';

            html += `
                <tr class="order-row" data-inv="${inv.name}">
                    <td>
                        <input type="checkbox" class="inv-checkbox" data-inv="${inv.name}"
                               style="width:16px; height:16px; cursor:pointer;">
                    </td>
                    <td><a href="/app/sales-invoice/${inv.name}" target="_blank" class="order-link">${inv.name}</a></td>
                    <td><a href="/app/customer/${inv.customer}" target="_blank" class="customer-link">${inv.customer_name || inv.customer}</a></td>
                    <td>${frappe.datetime.str_to_user(inv.posting_date)}</td>
                    <td><span class="amount-badge">${format_currency(inv.grand_total)}</span></td>
                    <td>
                        <span style="font-weight:600; color: ${inv.outstanding_amount > 0 ? '#dc2626' : '#059669'};">
                            ${format_currency(inv.outstanding_amount || 0)}
                        </span>
                    </td>
                    <td>
                        <span class="badge ${status_color}" style="font-size:11px;">${inv.status || '-'}</span>
                    </td>
                    <td>
                        <button class="btn btn-xs btn-default btn-print-inv" data-inv="${inv.name}" title="Print">
                            🖨 Print
                        </button>
                    </td>
                </tr>
            `;
        });

        html += `</tbody></table>
        ${this._pagination_html(all_filtered.length, 'invoices_page', '#dm-tab-invoices', () => this.render_sales_invoices())}
        </div></div>${this.shared_styles()}`;
        $tab.html(html);
        this.attach_invoices_events();
        this._attach_pagination_events('#dm-tab-invoices', 'invoices_page', all_filtered.length, () => this.render_sales_invoices());
    }

    attach_invoices_events() {
        const $tab = $('#dm-tab-invoices');
        const self = this;

        $tab.find('.select-all-invoices').off('change').on('change', function() {
            $tab.find('.inv-checkbox').prop('checked', $(this).is(':checked'));
        });

        $tab.find('.btn-print-inv').off('click').on('click', function() {
            self.print_document('Sales Invoice', $(this).data('inv'));
        });

        $tab.find('.btn-print-invoices').off('click').on('click', function() {
            const selected = [];
            $tab.find('.inv-checkbox:checked').each(function() {
                selected.push($(this).data('inv'));
            });
            if (!selected.length) {
                frappe.msgprint(__('Please select at least one invoice to print'));
                return;
            }
            selected.forEach(name => self.print_document('Sales Invoice', name));
        });
    }

    // ─── Shared helpers ───────────────────────────────────────────────────────

    summary_cards(items) {
        const cards = items.map(item => `
            <div class="summary-item">
                <div class="summary-icon" style="background: linear-gradient(135deg, ${item.color});"></div>
                <div class="summary-content">
                    <div class="summary-label">${item.label}</div>
                    <div class="summary-value">${item.value}</div>
                </div>
            </div>
        `).join('');
        return `<div class="summary-card">${cards}</div>`;
    }

    _pagination_html(total, page_key, tab_selector, render_fn) {
        if (total <= this.page_size) return '';
        const current = this[page_key];
        const total_pages = Math.ceil(total / this.page_size);
        const start = (current - 1) * this.page_size + 1;
        const end   = Math.min(current * this.page_size, total);
        return `<div class="dm-pg-bar">
            <button class="btn btn-xs btn-default dm-pg-prev" ${current <= 1 ? 'disabled' : ''}>&lsaquo; Prev</button>
            <span class="dm-pg-info">Showing ${start}–${end} of ${total} &nbsp;·&nbsp; Page ${current} of ${total_pages}</span>
            <button class="btn btn-xs btn-default dm-pg-next" ${current >= total_pages ? 'disabled' : ''}>Next &rsaquo;</button>
        </div>`;
    }

    _attach_pagination_events(tab_selector, page_key, total, render_fn) {
        const $tab = $(tab_selector);
        const total_pages = Math.ceil(total / this.page_size);
        $tab.find('.dm-pg-prev').off('click').on('click', () => {
            if (this[page_key] > 1) { this[page_key]--; render_fn(); }
        });
        $tab.find('.dm-pg-next').off('click').on('click', () => {
            if (this[page_key] < total_pages) { this[page_key]++; render_fn(); }
        });
    }

    shared_styles() {
        return `
            <style>
                .delivery-orders-table {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }
                .summary-card {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                    margin-bottom: 20px;
                }
                .summary-item {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    display: flex;
                    align-items: center;
                    gap: 15px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                }
                .summary-icon {
                    width: 50px;
                    height: 50px;
                    border-radius: 10px;
                    flex-shrink: 0;
                }
                .summary-label { font-size: 13px; color: #6b7280; margin-bottom: 4px; font-weight: 500; }
                .summary-value { font-size: 22px; font-weight: 700; color: #111827; }
                .table-wrapper {
                    background: white;
                    border-radius: 12px;
                    overflow: hidden;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                }
                .modern-table { margin-bottom: 0 !important; }
                .modern-table thead { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                .modern-table thead th {
                    color: white !important;
                    font-weight: 600;
                    font-size: 12px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    padding: 14px 12px !important;
                    border: none !important;
                }
                .order-row { transition: all 0.2s; border-left: 3px solid transparent; }
                .order-row:hover { background-color: #f3f4f6 !important; border-left-color: #667eea; }
                .order-row.order-overdue { background-color: #fef2f2; }
                .order-row td { padding: 12px !important; vertical-align: middle !important; }
                .order-link, .customer-link { color: #667eea; font-weight: 600; text-decoration: none; }
                .order-link:hover, .customer-link:hover { color: #764ba2; text-decoration: underline; }
                .phone-link { color: #0891b2; font-weight: 600; text-decoration: none; }
                .amount-badge {
                    display: inline-block;
                    padding: 4px 10px;
                    border-radius: 6px;
                    font-weight: 600;
                    font-size: 13px;
                    background: rgba(67, 233, 123, 0.1);
                    color: #059669;
                }
                .region-tag {
                    display: inline-block;
                    padding: 3px 8px;
                    background: #f3f4f6;
                    border-radius: 6px;
                    font-size: 12px;
                    color: #4b5563;
                    font-weight: 500;
                }
                .date-normal { color: #059669; font-weight: 600; }
                .date-overdue { color: #dc2626; font-weight: 700; }
                .overdue-badge {
                    margin-left: 6px;
                    padding: 2px 6px;
                    background: #dc2626;
                    color: white;
                    border-radius: 10px;
                    font-size: 10px;
                    font-weight: 700;
                }
                .item-row { margin-bottom: 10px; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; background: white; }
                .item-header { font-weight: 600; margin-bottom: 8px; color: #111827; font-size: 14px; }
                .item-details { display: flex; gap: 20px; flex-wrap: wrap; font-size: 13px; color: #6b7280; }
                .item-details strong { color: #374151; }
                .dm-pg-bar {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 14px;
                    padding: 12px 16px;
                    border-top: 1px solid #e5e7eb;
                    background: #f9fafb;
                    margin-top: 4px;
                }
                .dm-pg-info { font-size: 13px; color: #6b7280; }
                .dm-pg-bar .btn { min-width: 70px; }
            </style>
        `;
    }
}
