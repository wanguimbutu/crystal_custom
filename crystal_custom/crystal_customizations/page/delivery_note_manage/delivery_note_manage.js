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
        this.filters = { regions: [], customer: null, truck: null };
        this.orders = [];
        this.delivery_notes = [];
        this.invoices = [];
        this.selected_orders = new Set();
        this.active_tab = 'pending';
        this.pending_view = 'table'; // 'table' | 'trucks'
        this.truck_meta = {};
        this.closed_trucks = [];
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
            label: 'Truck',
            fieldtype: 'Data',
            fieldname: 'truck_filter',
            change: () => this.apply_filters(),
        });

        this.page.add_field({
            label: 'Sales Person',
            fieldtype: 'Link',
            fieldname: 'sales_person',
            options: 'Sales Person',
            change: () => { this.orders_page = 1; this.dns_page = 1; this.invoices_page = 1; this.load_data(); }
        });

        this.page.set_primary_action('Loading Sheet', () => this.generate_loading_sheet(), 'octicon octicon-list-unordered');
        this.page.add_button('Packing List', () => this.generate_packing_list());
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
        const fields = ['name', 'customer', 'customer_name', 'transaction_date', 'grand_total',
                        'custom_delivery_region', 'custom_phone_number', 'delivery_date',
                        'per_delivered', 'status', 'workflow_state', 'docstatus',
                        'custom_truck_number', 'total_net_weight', 'custom_truck_closed'];

        const submitted_base = [
            ['Sales Order', 'docstatus', '=', 1],
            ['Sales Order', 'per_delivered', '<', 100],
            ['Sales Order', 'status', '!=', 'Closed'],
        ];
        if (sp_orders) submitted_base.push(['Sales Team', 'sales_person', '=', sp_orders]);

        // Submitted truck-assigned orders: no date filter so they always appear
        const truck_filters = [
            ...submitted_base,
            ['Sales Order', 'custom_truck_number', '!=', ''],
        ];

        // Submitted unassigned orders: respect the date filter (for table view)
        const unassigned_filters = [
            ...submitted_base,
            ['Sales Order', 'transaction_date', 'between', [from_date, to_date]],
        ];

        // Draft (pending) truck-assigned orders: show in truck view as "Pending"
        const draft_truck_filters = [
            ['Sales Order', 'docstatus', '=', 0],
            ['Sales Order', 'custom_truck_number', '!=', ''],
            ['Sales Order', 'custom_truck_closed', '!=', 1],
        ];
        if (sp_orders) draft_truck_filters.push(['Sales Team', 'sales_person', '=', sp_orders]);

        let truck_rows = [], unassigned_rows = [], draft_truck_rows = [], raw_meta = [], raw_closed = [];
        let truck_done = false, unassigned_done = false, draft_done = false, meta_done = false, closed_done = false;

        const try_render = () => {
            if (!truck_done || !unassigned_done || !draft_done || !meta_done || !closed_done) return;

            // Build truck_meta: active trucks first, then fill in closed truck meta
            this.truck_meta = {};
            raw_meta.forEach(t => { this.truck_meta[t.truck_number] = t; });
            raw_closed.forEach(ct => {
                if (!this.truck_meta[ct.truck_number]) {
                    this.truck_meta[ct.truck_number] = { driver_name: ct.driver_name, capacity_kg: ct.capacity_kg };
                }
            });

            // Merge: submitted truck + submitted unassigned + draft truck (deduplicate by name)
            const seen = new Set(truck_rows.map(o => o.name));
            const unassigned_new = unassigned_rows.filter(o => !seen.has(o.name));
            unassigned_new.forEach(o => seen.add(o.name));
            const draft_new = draft_truck_rows.filter(o => !seen.has(o.name));
            this.orders = [...truck_rows, ...unassigned_new, ...draft_new];
            this.render_pending_orders();
            this._check_auto_close();
        };

        frappe.call({
            method: 'frappe.client.get_list',
            args: { doctype: 'Sales Order', fields, filters: truck_filters,
                    order_by: 'transaction_date desc', limit_page_length: 500 },
            callback: r => { truck_rows = r.message || []; truck_done = true; try_render(); },
            error:    () => { truck_done = true; try_render(); },
        });

        frappe.call({
            method: 'frappe.client.get_list',
            args: { doctype: 'Sales Order', fields, filters: unassigned_filters,
                    order_by: 'transaction_date desc', limit_page_length: 500 },
            callback: r => { unassigned_rows = r.message || []; unassigned_done = true; try_render(); },
            error:    () => { unassigned_done = true; try_render(); },
        });

        frappe.call({
            method: 'frappe.client.get_list',
            args: { doctype: 'Sales Order', fields, filters: draft_truck_filters,
                    order_by: 'transaction_date desc', limit_page_length: 500 },
            callback: r => { draft_truck_rows = r.message || []; draft_done = true; try_render(); },
            error:    () => { draft_done = true; try_render(); },
        });

        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_meta',
            callback: r => {
                try { raw_meta = JSON.parse(r.message || '[]'); } catch(e) { raw_meta = []; }
                meta_done = true; try_render();
            },
            error: () => { meta_done = true; try_render(); },
        });

        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_closed_trucks',
            callback: r => {
                try { raw_closed = JSON.parse(r.message || '[]'); this.closed_trucks = raw_closed; }
                catch(e) { raw_closed = []; this.closed_trucks = []; }
                closed_done = true; try_render();
            },
            error: () => { raw_closed = []; this.closed_trucks = []; closed_done = true; try_render(); },
        });
    }

    _check_auto_close() {
        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.check_and_auto_close_trucks',
            callback: r => {
                const closed = r.message || [];
                if (closed.length) {
                    frappe.show_alert({
                        message: __('Auto-closed {0} truck(s) — all orders fully delivered & billed: {1}',
                            [closed.length, closed.join(', ')]),
                        indicator: 'green',
                    }, 10);
                    this.load_pending_orders();
                }
            },
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
        const truck    = (this.page.fields_dict.truck_filter.get_value() || '').trim();
        this.filters = {
            regions: regions ? [regions] : [],
            customer: customer,
            truck: truck || null,
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
            if (this.filters.truck && order.custom_truck_number !== this.filters.truck) return false;
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

        const total_value  = all_filtered.reduce((sum, o) => sum + o.grand_total, 0);
        const total_weight = all_filtered.reduce((sum, o) => sum + (o.total_net_weight || 0), 0);
        const regions = [...new Set(all_filtered.map(o => o.custom_delivery_region).filter(r => r))];
        const trucks  = [...new Set(all_filtered.map(o => o.custom_truck_number).filter(t => t))];

        // Group by truck for sorted rendering
        const sorted = [...all_filtered].sort((a, b) => {
            const ta = a.custom_truck_number || '';
            const tb = b.custom_truck_number || '';
            if (!ta && !tb) return 0;
            if (!ta) return 1;
            if (!tb) return -1;
            return ta.localeCompare(tb);
        });
        const page_slice = sorted.slice(
            (this.orders_page - 1) * this.page_size,
            this.orders_page * this.page_size
        );

        // Group current page by truck
        const groups = {};
        page_slice.forEach(o => {
            const k = o.custom_truck_number || '__no_truck__';
            if (!groups[k]) groups[k] = [];
            groups[k].push(o);
        });
        const group_keys = Object.keys(groups).sort((a, b) => {
            if (a === '__no_truck__') return 1;
            if (b === '__no_truck__') return -1;
            return a.localeCompare(b);
        });

        const view_toggle = `
            <div class="dm-view-toggle">
                <button class="dm-view-btn ${this.pending_view === 'table' ? 'dm-view-btn-active' : ''}" data-view="table">
                    &#9776; Table View
                </button>
                <button class="dm-view-btn ${this.pending_view === 'trucks' ? 'dm-view-btn-active' : ''}" data-view="trucks">
                    &#128666; Truck View
                </button>
            </div>`;

        const summary = this.summary_cards([
            { label: 'Orders', value: all_filtered.length, color: '#667eea, #764ba2' },
            { label: 'Total Value', value: format_currency(total_value), color: '#43e97b, #38f9d7' },
            { label: 'Total Weight', value: `${total_weight.toFixed(0)} kg`, color: '#f093fb, #f5576c' },
            { label: 'Trucks', value: trucks.length, color: '#f59e0b, #d97706' }
        ]);

        if (this.pending_view === 'trucks') {
            $tab.html(`<div class="delivery-orders-table">${summary}${view_toggle}${this._render_dm_truck_cards(all_filtered)}</div>${this.shared_styles()}`);
            this.attach_pending_events();
            return;
        }

        let html = `<div class="delivery-orders-table">${summary}${view_toggle}
                <div class="dm-selection-bar">
                    <label class="dm-sel-all-label">
                        <input type="checkbox" id="dm-select-all" style="width:15px;height:15px;accent-color:#667eea;">
                        Select All (${all_filtered.length})
                    </label>
                    <span class="dm-sel-count" id="dm-sel-count">${this.selected_orders.size} selected</span>
                </div>

                <div class="table-wrapper">
                    <table class="table table-bordered modern-table">
                        <thead>
                            <tr>
                                <th width="3%"></th>
                                <th width="3%"></th>
                                <th width="11%">Sales Order</th>
                                <th width="13%">Customer</th>
                                <th width="10%">Phone</th>
                                <th width="8%">Amount</th>
                                <th width="8%">Order Date</th>
                                <th width="8%">Del. Date</th>
                                <th width="9%">Truck</th>
                                <th width="9%">Region</th>
                                <th width="11%">Action</th>
                            </tr>
                        </thead>
                        <tbody>`;

        group_keys.forEach(key => {
            const grp = groups[key];
            const grp_label = key === '__no_truck__' ? 'No Truck' : `Truck: ${key}`;
            const grp_val   = grp.reduce((s, o) => s + o.grand_total, 0);
            const grp_wt    = grp.reduce((s, o) => s + (o.total_net_weight || 0), 0);
            html += `
                <tr class="dm-truck-header">
                    <td colspan="11">
                        ${key === '__no_truck__' ? '📋' : '🚛'} ${frappe.utils.escape_html(grp_label)}
                        <span class="dm-truck-meta">${grp.length} orders &nbsp;·&nbsp; ${format_currency(grp_val)} &nbsp;·&nbsp; ${grp_wt.toFixed(0)} kg</span>
                    </td>
                </tr>`;

            grp.forEach(order => {
                const delivery_date = order.delivery_date || order.transaction_date;
                const is_overdue    = delivery_date && frappe.datetime.get_diff(frappe.datetime.get_today(), delivery_date) > 0;
                const is_selected   = this.selected_orders.has(order.name);

                html += `
                <tr class="order-row ${is_overdue ? 'order-overdue' : ''} ${is_selected ? 'dm-row-selected' : ''}" data-order="${order.name}">
                    <td style="text-align:center;">
                        <input type="checkbox" class="dm-order-chk" data-order="${order.name}"
                               ${is_selected ? 'checked' : ''} style="width:15px;height:15px;accent-color:#667eea;cursor:pointer;">
                    </td>
                    <td><span class="toggle-details" style="cursor:pointer;font-size:16px;">▶</span></td>
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
                    <td>${order.custom_truck_number
                        ? `<span class="region-tag">${frappe.utils.escape_html(order.custom_truck_number)}</span>`
                        : '<span class="text-muted">—</span>'}
                    </td>
                    <td><span class="region-tag">${order.custom_delivery_region || '-'}</span></td>
                    <td>
                        <button class="btn btn-sm btn-primary btn-create-dn" data-order="${order.name}">
                            Create DN
                        </button>
                    </td>
                </tr>
                <tr class="order-details-row" data-order="${order.name}" style="display:none;">
                    <td colspan="11">
                        <div class="order-details-container" style="padding:15px; background:#f8f9fa;">
                            <div class="loading">Loading items...</div>
                        </div>
                    </td>
                </tr>`;
            });
        });

        html += `</tbody></table>
        ${this._pagination_html(all_filtered.length, 'orders_page', '#dm-tab-pending', () => this.render_pending_orders())}
        </div></div>${this.shared_styles()}`;
        $tab.html(html);
        this.attach_pending_events();
        this._attach_pagination_events('#dm-tab-pending', 'orders_page', all_filtered.length, () => this.render_pending_orders());
    }
    ca

    attach_pending_events() {
        const self = this;

        // Select all
        $('#dm-select-all').off('change').on('change', function () {
            const checked = $(this).is(':checked');
            self.get_filtered_orders().forEach(o => {
                checked ? self.selected_orders.add(o.name) : self.selected_orders.delete(o.name);
            });
            $('#dm-tab-pending .dm-order-chk').prop('checked', checked);
            $('#dm-sel-count').text(`${self.selected_orders.size} selected`);
        });

        // Individual checkbox
        $('#dm-tab-pending').find('.dm-order-chk').off('change').on('change', function () {
            const name = $(this).data('order');
            $(this).is(':checked') ? self.selected_orders.add(name) : self.selected_orders.delete(name);
            $(this).closest('tr').toggleClass('dm-row-selected', $(this).is(':checked'));
            $('#dm-sel-count').text(`${self.selected_orders.size} selected`);
        });

        // Expand toggle
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

        // Truck-level Loading Sheet / Packing List
        $('#dm-tab-pending').find('.dm-tc-ls-btn').off('click').on('click', function(e) {
            e.stopPropagation();
            self._generate_truck_doc($(this).data('truck'), 'loading_sheet');
        });
        $('#dm-tab-pending').find('.dm-tc-pl-btn').off('click').on('click', function(e) {
            e.stopPropagation();
            self._generate_truck_doc($(this).data('truck'), 'packing_list');
        });

        // View toggle
        $('#dm-tab-pending').find('.dm-view-btn').off('click').on('click', function() {
            const view = $(this).data('view');
            if (self.pending_view !== view) {
                self.pending_view = view;
                self.render_pending_orders();
            }
        });
    }

    _render_dm_truck_cards(orders) {
        // Separate active-truck orders from closed-truck orders
        const truck_map = {};
        const no_truck  = [];
        orders.forEach(o => {
            if (o.custom_truck_number && !o.custom_truck_closed) {
                if (!truck_map[o.custom_truck_number]) truck_map[o.custom_truck_number] = [];
                truck_map[o.custom_truck_number].push(o);
            } else if (!o.custom_truck_number) {
                no_truck.push(o);
            }
            // custom_truck_closed orders are rendered via the closed_trucks section below
        });

        const _truck_card_html = (truck_num, t_orders, meta, is_closed) => {
            const total_val = t_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
            const total_wt  = t_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
            const capacity  = (meta && meta.capacity_kg) || 0;
            const cap_pct   = capacity > 0 ? Math.min((total_wt / capacity) * 100, 100).toFixed(0) : null;

            const order_rows = t_orders.map(o => {
                const delivery_date = o.delivery_date || o.transaction_date;
                const is_overdue    = delivery_date && frappe.datetime.get_diff(frappe.datetime.get_today(), delivery_date) > 0;
                const is_draft      = o.docstatus === 0;
                const state_label   = o.workflow_state || (is_draft ? 'Draft' : '');
                return `<div class="dm-tc-order${is_draft ? ' dm-tc-order-draft' : ''}">
                    <div class="dm-tc-order-main">
                        <a href="/app/sales-order/${o.name}" target="_blank" class="order-link">${frappe.utils.escape_html(o.name)}</a>
                        <span class="dm-tc-cust">${frappe.utils.escape_html(o.customer_name || o.customer)}</span>
                        ${o.custom_delivery_region ? `<span class="region-tag" style="font-size:10px;">${frappe.utils.escape_html(o.custom_delivery_region)}</span>` : ''}
                    </div>
                    <div class="dm-tc-order-right">
                        ${o.grand_total ? `<span class="amount-badge" style="font-size:11px;">${format_currency(o.grand_total, null, 0)}</span>` : ''}
                        ${is_overdue ? '<span class="overdue-badge">OVERDUE</span>' : ''}
                        ${is_draft
                            ? `<span class="dm-tc-pending-badge" title="${frappe.utils.escape_html(state_label)}">Pending</span>`
                            : `<button class="btn btn-xs btn-primary btn-create-dn" data-order="${o.name}" style="margin-left:6px;">Create DN</button>`
                        }
                    </div>
                </div>`;
            }).join('');

            const head_bg = is_closed ? '#475569' : '#1e293b';
            return `<div class="dm-truck-card">
                <div class="dm-tc-head" style="background:${head_bg};">
                    <span class="dm-tc-num">&#128666; ${frappe.utils.escape_html(truck_num)}</span>
                    <span style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;">
                        ${(meta && meta.driver_name) ? `<span class="dm-tc-driver">${frappe.utils.escape_html(meta.driver_name)}</span>` : ''}
                        ${is_closed ? '<span style="font-size:10px;background:#64748b;padding:1px 6px;border-radius:10px;color:#e2e8f0;">Dispatched</span>' : ''}
                    </span>
                </div>
                <div class="dm-tc-stats">
                    <span>${t_orders.length} order${t_orders.length !== 1 ? 's' : ''}</span>
                    <span class="dm-tc-val">${format_currency(total_val, null, 0)}</span>
                    <span class="dm-tc-wt">${total_wt.toFixed(0)} kg</span>
                </div>
                ${cap_pct !== null ? `
                <div class="sos-tc-cap-bar">
                    <div class="sos-tc-cap-fill" style="width:${cap_pct}%;background:${cap_pct > 90 ? '#ef4444' : '#10b981'}"></div>
                </div>
                <div class="sos-tc-cap-label">${cap_pct}% of ${capacity.toLocaleString()} kg</div>
                ` : ''}
                <div class="dm-tc-orders">${order_rows}</div>
                ${!is_closed ? `
                <div class="dm-tc-doc-actions" data-truck="${frappe.utils.escape_html(truck_num)}">
                    <button class="btn btn-xs btn-default dm-tc-ls-btn" data-truck="${frappe.utils.escape_html(truck_num)}">&#128203; Loading Sheet</button>
                    <button class="btn btn-xs btn-default dm-tc-pl-btn" data-truck="${frappe.utils.escape_html(truck_num)}">&#128230; Packing List</button>
                </div>` : ''}
            </div>`;
        };

        // ── Active trucks from live orders ──────────────────────────────────────
        const truck_numbers = Object.keys(truck_map).sort();
        let html = '';

        if (truck_numbers.length) {
            html += '<div class="dm-truck-grid">';
            truck_numbers.forEach(truck_num => {
                html += _truck_card_html(truck_num, truck_map[truck_num], this.truck_meta[truck_num], false);
            });
            html += '</div>';
        }

        // ── Dispatched (closed) trucks ──────────────────────────────────────────
        const closed_trucks = this.closed_trucks || [];
        if (closed_trucks.length) {
            html += `<div style="margin-top:24px;">
                <div style="font-weight:700;font-size:13px;color:#475569;margin-bottom:10px;letter-spacing:.5px;text-transform:uppercase;">
                    &#128666; Dispatched Trucks (${closed_trucks.length})
                </div>
                <div class="dm-truck-grid">`;

            closed_trucks.forEach(ct => {
                // Use live orders if they loaded, fall back to closure record order list
                const live_orders = orders.filter(o => o.custom_truck_number === ct.truck_number && o.custom_truck_closed);
                const display_orders = live_orders.length
                    ? live_orders
                    : (ct.orders || []).map(o => ({
                        name:                o.name,
                        customer_name:       o.customer_name,
                        custom_delivery_region: o.delivery_region || '',
                        grand_total:         0,
                        total_net_weight:    0,
                        delivery_date:       null,
                        transaction_date:    null,
                    }));

                html += _truck_card_html(ct.truck_number, display_orders,
                    { driver_name: ct.driver_name, capacity_kg: ct.capacity_kg }, true);
            });

            html += '</div></div>';
        }

        if (!truck_numbers.length && !closed_trucks.length) {
            html = `<div style="padding:30px;text-align:center;color:#6b7280;">
                No orders with truck assignments in the selected date range.
                ${no_truck.length ? `<br><br>${no_truck.length} order${no_truck.length !== 1 ? 's' : ''} have no truck assigned.` : ''}
            </div>`;
        }

        if (no_truck.length) {
            html += `<div class="dm-tv-unassigned">
                ${no_truck.length} order${no_truck.length !== 1 ? 's' : ''} without truck assignment
            </div>`;
        }

        html += `<style>
            .dm-truck-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 18px; margin-top: 16px; }
            .dm-truck-card { background: #fff; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.08); overflow: hidden; }
            .dm-tc-head { background: #1e293b; color: #f1f5f9; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
            .dm-tc-num { font-weight: 700; font-size: 13px; }
            .dm-tc-driver { font-size: 11px; color: #94a3b8; }
            .dm-tc-stats { display: flex; gap: 14px; padding: 10px 16px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #475569; }
            .dm-tc-val { font-weight: 600; color: #374151; }
            .dm-tc-wt { color: #6b7280; }
            .dm-tc-orders { padding: 8px 12px; }
            .dm-tc-order { display: flex; justify-content: space-between; align-items: center; padding: 8px 4px; border-bottom: 1px solid #f1f5f9; gap: 8px; }
            .dm-tc-order:last-child { border-bottom: none; }
            .dm-tc-order-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
            .dm-tc-cust { font-size: 11px; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
            .dm-tc-order-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
            .dm-tc-order-draft { background: #fffbeb; border-left: 3px solid #f59e0b; padding-left: 6px; }
            .dm-tc-pending-badge { font-size: 10px; font-weight: 700; padding: 2px 7px; background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; border-radius: 10px; white-space: nowrap; }
            .dm-tv-unassigned { margin-top: 16px; padding: 10px 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; color: #6b7280; }
            .dm-tc-doc-actions { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid #f1f5f9; background: #f8fafc; }
            .dm-tc-ls-btn, .dm-tc-pl-btn { font-size: 11px !important; padding: 3px 10px !important; border-radius: 4px !important; }
            .dm-view-toggle { display: flex; gap: 6px; margin-bottom: 16px; }
            .dm-view-btn { background: #fff; border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 16px; font-size: 13px; font-weight: 600; color: #374151; cursor: pointer; }
            .dm-view-btn:hover { background: #f3f4f6; }
            .dm-view-btn-active { background: #1e293b; color: #fff; border-color: #1e293b; }
        </style>`;

        return html;
    }

    // ─── Per-truck Loading Sheet / Packing List ──────────────────────────────

    _generate_truck_doc(truck_num, doc_type) {
        const truck_orders = this.orders.filter(o =>
            o.custom_truck_number === truck_num && !o.custom_truck_closed && o.docstatus === 1
        );
        if (!truck_orders.length) {
            frappe.msgprint(__('No submitted orders found for truck {0}', [truck_num]));
            return;
        }
        const order_names = truck_orders.map(o => o.name);
        const orders_map  = {};
        truck_orders.forEach(o => { orders_map[o.name] = o; });

        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.delivery_note_manage.delivery_note_manage.get_order_items',
            args: { order_names },
            freeze: true,
            freeze_message: __('Loading items…'),
            callback: (r) => {
                const raw_items = r.message || [];
                if (doc_type === 'loading_sheet') {
                    const agg = {};
                    raw_items.forEach(i => {
                        const pending = (i.qty || 0) - (i.delivered_qty || 0);
                        if (pending <= 0) return;
                        if (!agg[i.item_code]) {
                            agg[i.item_code] = { item_code: i.item_code, item_name: i.item_name, qty: 0, uom: i.uom, weight: 0, amount: 0 };
                        }
                        agg[i.item_code].qty    += pending;
                        agg[i.item_code].weight += pending * (i.weight_per_unit || 0);
                        agg[i.item_code].amount += pending * (i.rate || 0);
                    });
                    const items = Object.values(agg).sort((a, b) => a.item_code.localeCompare(b.item_code));
                    this._print_loading_sheet_for_truck(truck_num, order_names, items);
                } else {
                    this._print_packing_list_for_truck(truck_num, order_names, raw_items, orders_map);
                }
            },
        });
    }

    _print_loading_sheet_for_truck(truck_num, order_names, items) {
        const today      = frappe.datetime.str_to_user(frappe.datetime.get_today());
        const meta       = this.truck_meta[truck_num] || {};
        const total_qty    = items.reduce((s, i) => s + i.qty, 0);
        const total_weight = items.reduce((s, i) => s + i.weight, 0);

        const rows = items.map((item, idx) => `
            <tr>
                <td>${idx + 1}</td>
                <td><strong>${item.item_code}</strong></td>
                <td>${item.item_name}</td>
                <td style="text-align:right;"><strong>${item.qty.toFixed(2)}</strong></td>
                <td>${item.uom}</td>
                <td style="text-align:right;">${item.weight > 0 ? item.weight.toFixed(2) : '—'}</td>
                <td style="text-align:center;">___________</td>
            </tr>`).join('');

        const w = window.open('', '_blank');
        w.document.write(`<!DOCTYPE html><html>
<head><meta charset="utf-8"><title>Loading Sheet — ${truck_num}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:13px;margin:20px;}
  h2{margin:0 0 4px;}
  .meta{color:#555;margin-bottom:16px;font-size:12px;}
  table{border-collapse:collapse;width:100%;}
  th,td{border:1px solid #bbb;padding:7px 10px;}
  th{background:#1e293b;color:#fff;text-align:left;}
  tfoot td{background:#f1f5f9;font-weight:700;}
  @media print{.no-print{display:none}}
</style></head><body>
<button class="no-print" onclick="window.print()" style="float:right;padding:6px 16px;background:#1e293b;color:#fff;border:none;border-radius:4px;cursor:pointer;">Print</button>
<h2>LOADING SHEET</h2>
<div class="meta">
  Date: ${today}
  &nbsp;|&nbsp; Truck: <strong>${truck_num}</strong>
  ${meta.driver_name ? ` &nbsp;|&nbsp; Driver: <strong>${meta.driver_name}</strong>` : ''}
  ${meta.capacity_kg ? ` &nbsp;|&nbsp; Capacity: <strong>${Number(meta.capacity_kg).toLocaleString()} kg</strong>` : ''}
  &nbsp;|&nbsp; Orders: <strong>${order_names.length}</strong>
  &nbsp;|&nbsp; Items: <strong>${items.length}</strong>
</div>
<table>
  <thead><tr>
    <th width="4%">#</th><th width="13%">Item Code</th><th width="32%">Description</th>
    <th width="10%">Qty</th><th width="7%">UOM</th>
    <th width="12%">Weight (kg)</th><th width="16%">Loaded ✓</th>
  </tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr>
    <td colspan="3" style="text-align:right;">TOTALS</td>
    <td>${total_qty.toFixed(2)}</td><td>—</td>
    <td>${total_weight > 0 ? total_weight.toFixed(2) : '—'}</td><td></td>
  </tr></tfoot>
</table>
<p style="margin-top:24px;font-size:11px;color:#888;">Generated: ${today} &nbsp;·&nbsp; Crystal Customs</p>
</body></html>`);
        w.document.close();
    }

    _print_packing_list_for_truck(truck_num, order_names, raw_items, orders_map) {
        const today = frappe.datetime.str_to_user(frappe.datetime.get_today());
        const meta  = this.truck_meta[truck_num] || {};

        // Group items by order
        const order_items = {};
        raw_items.forEach(i => {
            const pending = (i.qty || 0) - (i.delivered_qty || 0);
            if (pending <= 0) return;
            if (!order_items[i.parent]) order_items[i.parent] = [];
            order_items[i.parent].push({ ...i, pending_qty: pending });
        });

        // Aggregate totals across all orders
        const totals = {};
        raw_items.forEach(i => {
            const pending = (i.qty || 0) - (i.delivered_qty || 0);
            if (pending <= 0) return;
            if (!totals[i.item_code]) totals[i.item_code] = { item_code: i.item_code, item_name: i.item_name, qty: 0, uom: i.uom };
            totals[i.item_code].qty += pending;
        });

        // Sort by customer name
        const sorted_orders = order_names
            .filter(n => order_items[n])
            .sort((a, b) => ((orders_map[a] || {}).customer_name || '').localeCompare((orders_map[b] || {}).customer_name || ''));

        let customer_blocks = '';
        sorted_orders.forEach(order_name => {
            const o     = orders_map[order_name] || { customer_name: order_name };
            const items = order_items[order_name] || [];
            const subtotal_weight = items.reduce((s, i) => s + i.pending_qty * (i.weight_per_unit || 0), 0);
            const subtotal_qty    = items.reduce((s, i) => s + i.pending_qty, 0);

            const item_rows = items.map((item, idx) => `
                <tr>
                    <td>${idx + 1}</td>
                    <td><strong>${item.item_code}</strong></td>
                    <td>${item.item_name}</td>
                    <td style="text-align:right;">${item.pending_qty.toFixed(2)}</td>
                    <td>${item.uom}</td>
                    <td style="text-align:right;">${(item.pending_qty * (item.weight_per_unit || 0)).toFixed(2)}</td>
                </tr>`).join('');

            customer_blocks += `
            <div class="customer-block">
                <div class="cust-header">
                    <span class="cust-name">${o.customer_name || order_name}</span>
                    <span class="cust-meta">
                        ${order_name}
                        ${o.custom_delivery_region ? ` &nbsp;·&nbsp; ${o.custom_delivery_region}` : ''}
                    </span>
                </div>
                <table>
                    <thead><tr><th>#</th><th>Item Code</th><th>Description</th><th>Qty</th><th>UOM</th><th>Weight (kg)</th></tr></thead>
                    <tbody>${item_rows}</tbody>
                    <tfoot><tr>
                        <td colspan="3" style="text-align:right;">Subtotal</td>
                        <td>${subtotal_qty.toFixed(2)}</td><td>—</td>
                        <td>${subtotal_weight.toFixed(2)}</td>
                    </tr></tfoot>
                </table>
                <div class="sig-line">Received by: ___________________________ &nbsp;&nbsp; Signature: ___________________________</div>
            </div>`;
        });

        const total_items = Object.values(totals).sort((a, b) => a.item_code.localeCompare(b.item_code));
        const grand_qty   = total_items.reduce((s, i) => s + i.qty, 0);
        const total_rows  = total_items.map((item, idx) => `
            <tr>
                <td>${idx + 1}</td>
                <td><strong>${item.item_code}</strong></td>
                <td>${item.item_name}</td>
                <td style="text-align:right;"><strong>${item.qty.toFixed(2)}</strong></td>
                <td>${item.uom}</td>
            </tr>`).join('');

        const w = window.open('', '_blank');
        w.document.write(`<!DOCTYPE html><html>
<head><meta charset="utf-8"><title>Packing List — ${truck_num}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#111;}
  h2{margin:0 0 4px;}
  .meta{color:#555;margin-bottom:20px;font-size:11px;}
  table{border-collapse:collapse;width:100%;margin-bottom:4px;}
  th,td{border:1px solid #bbb;padding:6px 9px;}
  th{background:#1e293b;color:#fff;text-align:left;font-size:11px;}
  tfoot td{background:#f1f5f9;font-weight:700;}
  .customer-block{margin-bottom:28px;page-break-inside:avoid;}
  .cust-header{background:#334155;color:#f1f5f9;padding:9px 12px;border-radius:4px 4px 0 0;display:flex;justify-content:space-between;align-items:center;}
  .cust-name{font-size:14px;font-weight:700;}
  .cust-meta{font-size:11px;color:#94a3b8;}
  .sig-line{margin-top:6px;padding:8px 4px;font-size:11px;color:#475569;border-top:1px dashed #cbd5e1;}
  .totals-section{border-top:3px solid #1e293b;padding-top:12px;margin-top:8px;}
  .totals-title{font-size:15px;font-weight:700;margin-bottom:8px;color:#1e293b;}
  @media print{.no-print{display:none}body{margin:10px}}
</style></head><body>
<button class="no-print" onclick="window.print()" style="float:right;padding:6px 16px;background:#1e293b;color:#fff;border:none;border-radius:4px;cursor:pointer;">Print</button>
<h2>PACKING LIST</h2>
<div class="meta">
  Date: ${today}
  &nbsp;|&nbsp; Truck: <strong>${truck_num}</strong>
  ${meta.driver_name ? ` &nbsp;|&nbsp; Driver: <strong>${meta.driver_name}</strong>` : ''}
  &nbsp;|&nbsp; Customers: <strong>${sorted_orders.length}</strong>
</div>

${customer_blocks}

<div class="totals-section">
  <div class="totals-title">GRAND TOTALS — All Items</div>
  <table>
    <thead><tr><th>#</th><th>Item Code</th><th>Description</th><th>Total Qty</th><th>UOM</th></tr></thead>
    <tbody>${total_rows}</tbody>
    <tfoot><tr>
      <td colspan="3" style="text-align:right;">TOTAL</td>
      <td>${grand_qty.toFixed(2)}</td><td>—</td>
    </tr></tfoot>
  </table>
</div>
<p style="margin-top:20px;font-size:10px;color:#888;">Generated: ${today} &nbsp;·&nbsp; Crystal Customs</p>
</body></html>`);
        w.document.close();
    }

    // ─── Loading Sheet & Packing List ────────────────────────────────────────

    _resolve_target_orders() {
        const targets = Array.from(this.selected_orders);
        if (targets.length) return targets;
        // If nothing selected, use all filtered orders
        return this.get_filtered_orders().map(o => o.name);
    }

    _fetch_order_items(order_names, callback) {
        if (!order_names.length) { frappe.msgprint(__('No orders to process.')); return; }
        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.delivery_note_manage.delivery_note_manage.get_order_items',
            args: { order_names: order_names },
            freeze: true,
            freeze_message: __('Loading items…'),
            callback: (r) => callback(r.message || []),
        });
    }

    generate_loading_sheet() {
        const order_names = this._resolve_target_orders();
        if (!order_names.length) { frappe.msgprint(__('No orders available.')); return; }

        this._fetch_order_items(order_names, (raw_items) => {
            const orders_map = {};
            this.get_filtered_orders().forEach(o => { orders_map[o.name] = o; });

            // Aggregate pending qty / weight / amount by item_code
            const agg = {};
            raw_items.forEach(i => {
                const pending = i.qty - (i.delivered_qty || 0);
                if (pending <= 0) return;
                if (!agg[i.item_code]) {
                    agg[i.item_code] = { item_code: i.item_code, item_name: i.item_name, qty: 0, uom: i.uom, weight: 0, amount: 0 };
                }
                agg[i.item_code].qty    += pending;
                agg[i.item_code].weight += pending * (i.weight_per_unit || 0);
                agg[i.item_code].amount += pending * (i.rate || 0);
            });

            const items = Object.values(agg).sort((a, b) => a.item_code.localeCompare(b.item_code));

            // Open print window immediately (same as original behaviour)
            this._print_loading_sheet(order_names, items, orders_map);

            // Also create a Loading Sheet document record in the background
            frappe.call({
                method: 'frappe.client.insert',
                args: {
                    doc: {
                        doctype: 'Loading Sheet',
                        date: frappe.datetime.get_today(),
                        loading_sheet_items: items.map(item => ({
                            doctype: 'Loading Sheet Items',
                            item_code: item.item_code,
                            item_name: item.item_name,
                            qty: Math.round(item.qty),
                            uom: item.uom,
                            amount: item.amount,
                        })),
                        customer_details: order_names.map(name => {
                            const o = orders_map[name] || {};
                            return {
                                doctype: 'Customer Details',
                                customer_name: o.customer_name || name,
                                delivery_notes: '',
                                amount: o.grand_total || 0,
                            };
                        }),
                    }
                },
                callback: (r) => {
                    if (r.message) {
                        frappe.show_alert({
                            message: __('Loading Sheet {0} saved — <a href="/app/loading-sheet/{1}" target="_blank">open</a>', [r.message.name, r.message.name]),
                            indicator: 'green',
                        }, 8);
                    }
                }
            });
        });
    }

    _print_loading_sheet(order_names, items, orders_map) {
        const total_qty    = items.reduce((s, i) => s + i.qty, 0);
        const total_weight = items.reduce((s, i) => s + i.weight, 0);

        const truck  = this.filters.truck || (order_names.length === 1 ? (orders_map[order_names[0]] || {}).custom_truck_number : '') || '';
        const region = this.filters.regions[0] || '';
        const today  = frappe.datetime.str_to_user(frappe.datetime.get_today());

        const rows = items.map((item, idx) => `
            <tr>
                <td>${idx + 1}</td>
                <td><strong>${item.item_code}</strong></td>
                <td>${item.item_name}</td>
                <td style="text-align:right;"><strong>${item.qty.toFixed(2)}</strong></td>
                <td>${item.uom}</td>
                <td style="text-align:right;">${item.weight > 0 ? item.weight.toFixed(2) : '—'}</td>
                <td style="text-align:center;">___________</td>
            </tr>`).join('');

        const html = `<!DOCTYPE html><html>
<head><meta charset="utf-8"><title>Loading Sheet</title>
<style>
  body{font-family:Arial,sans-serif;font-size:13px;margin:20px;}
  h2{margin:0 0 4px;}
  .meta{color:#555;margin-bottom:16px;font-size:12px;}
  table{border-collapse:collapse;width:100%;}
  th,td{border:1px solid #bbb;padding:7px 10px;}
  th{background:#1e293b;color:#fff;text-align:left;}
  tfoot td{background:#f1f5f9;font-weight:700;}
  @media print{.no-print{display:none}}
</style>
</head><body>
<button class="no-print" onclick="window.print()" style="float:right;padding:6px 16px;background:#1e293b;color:#fff;border:none;border-radius:4px;cursor:pointer;">Print</button>
<h2>LOADING SHEET</h2>
<div class="meta">
  Date: ${today}
  ${truck  ? ` &nbsp;|&nbsp; Truck: <strong>${truck}</strong>`   : ''}
  ${region ? ` &nbsp;|&nbsp; Region: <strong>${region}</strong>` : ''}
  &nbsp;|&nbsp; Orders: <strong>${order_names.length}</strong>
  &nbsp;|&nbsp; Items: <strong>${items.length}</strong>
</div>
<table>
  <thead><tr>
    <th width="4%">#</th><th width="13%">Item Code</th><th width="32%">Description</th>
    <th width="10%">Qty</th><th width="7%">UOM</th>
    <th width="12%">Weight (kg)</th><th width="16%">Loaded ✓</th>
  </tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr>
    <td colspan="3" style="text-align:right;">TOTALS</td>
    <td>${total_qty.toFixed(2)}</td><td>—</td>
    <td>${total_weight > 0 ? total_weight.toFixed(2) : '—'}</td><td></td>
  </tr></tfoot>
</table>
<p style="margin-top:24px;font-size:11px;color:#888;">Generated: ${today} &nbsp;·&nbsp; Crystal Customs</p>
</body></html>`;

        const w = window.open('', '_blank');
        w.document.write(html);
        w.document.close();
    }

    generate_packing_list() {
        const order_names = this._resolve_target_orders();
        if (!order_names.length) { frappe.msgprint(__('No orders available.')); return; }

        this._fetch_order_items(order_names, (raw_items) => {
            const orders_map = {};
            this.get_filtered_orders().forEach(o => { orders_map[o.name] = o; });

            // Group items by order
            const order_items = {};
            raw_items.forEach(i => {
                const pending = i.qty - (i.delivered_qty || 0);
                if (pending <= 0) return;
                if (!order_items[i.parent]) order_items[i.parent] = [];
                order_items[i.parent].push({ ...i, pending_qty: pending });
            });

            // Aggregate totals
            const totals = {};
            raw_items.forEach(i => {
                const pending = i.qty - (i.delivered_qty || 0);
                if (pending <= 0) return;
                if (!totals[i.item_code]) totals[i.item_code] = { item_code: i.item_code, item_name: i.item_name, qty: 0, uom: i.uom };
                totals[i.item_code].qty += pending;
            });

            // Sort orders by truck then customer
            const sorted_orders = order_names
                .filter(n => order_items[n])
                .sort((a, b) => {
                    const ta = (orders_map[a] || {}).custom_truck_number || '';
                    const tb = (orders_map[b] || {}).custom_truck_number || '';
                    if (ta !== tb) return ta.localeCompare(tb);
                    return ((orders_map[a] || {}).customer_name || '').localeCompare((orders_map[b] || {}).customer_name || '');
                });

            const truck  = this.filters.truck || '';
            const region = this.filters.regions[0] || '';
            const today  = frappe.datetime.str_to_user(frappe.datetime.get_today());

            let customer_blocks = '';
            sorted_orders.forEach(order_name => {
                const o     = orders_map[order_name] || { customer_name: order_name, custom_truck_number: '' };
                const items = order_items[order_name] || [];
                const subtotal_weight = items.reduce((s, i) => s + i.pending_qty * (i.weight_per_unit || 0), 0);
                const subtotal_qty    = items.reduce((s, i) => s + i.pending_qty, 0);

                const item_rows = items.map((item, idx) => `
                    <tr>
                        <td>${idx + 1}</td>
                        <td><strong>${item.item_code}</strong></td>
                        <td>${item.item_name}</td>
                        <td style="text-align:right;">${item.pending_qty.toFixed(2)}</td>
                        <td>${item.uom}</td>
                        <td style="text-align:right;">${(item.pending_qty * (item.weight_per_unit || 0)).toFixed(2)}</td>
                    </tr>`).join('');

                customer_blocks += `
                <div class="customer-block">
                    <div class="cust-header">
                        <span class="cust-name">${o.customer_name || order_name}</span>
                        <span class="cust-meta">
                            ${order_name}
                            ${o.custom_truck_number ? ` &nbsp;·&nbsp; Truck: <strong>${o.custom_truck_number}</strong>` : ''}
                            ${o.custom_delivery_region ? ` &nbsp;·&nbsp; ${o.custom_delivery_region}` : ''}
                        </span>
                    </div>
                    <table>
                        <thead><tr><th>#</th><th>Item Code</th><th>Description</th><th>Qty</th><th>UOM</th><th>Weight (kg)</th></tr></thead>
                        <tbody>${item_rows}</tbody>
                        <tfoot><tr>
                            <td colspan="3" style="text-align:right;">Subtotal</td>
                            <td>${subtotal_qty.toFixed(2)}</td><td>—</td>
                            <td>${subtotal_weight.toFixed(2)}</td>
                        </tr></tfoot>
                    </table>
                    <div class="sig-line">Received by: ___________________________ &nbsp;&nbsp; Signature: ___________________________</div>
                </div>`;
            });

            const total_items = Object.values(totals).sort((a, b) => a.item_code.localeCompare(b.item_code));
            const grand_qty   = total_items.reduce((s, i) => s + i.qty, 0);
            const total_rows  = total_items.map((item, idx) => `
                <tr>
                    <td>${idx + 1}</td>
                    <td><strong>${item.item_code}</strong></td>
                    <td>${item.item_name}</td>
                    <td style="text-align:right;"><strong>${item.qty.toFixed(2)}</strong></td>
                    <td>${item.uom}</td>
                </tr>`).join('');

            const html = `<!DOCTYPE html><html>
<head><meta charset="utf-8"><title>Packing List</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#111;}
  h2{margin:0 0 4px;}
  .meta{color:#555;margin-bottom:20px;font-size:11px;}
  table{border-collapse:collapse;width:100%;margin-bottom:4px;}
  th,td{border:1px solid #bbb;padding:6px 9px;}
  th{background:#1e293b;color:#fff;text-align:left;font-size:11px;}
  tfoot td{background:#f1f5f9;font-weight:700;}
  .customer-block{margin-bottom:28px;page-break-inside:avoid;}
  .cust-header{background:#334155;color:#f1f5f9;padding:9px 12px;border-radius:4px 4px 0 0;margin-bottom:0;display:flex;justify-content:space-between;align-items:center;}
  .cust-name{font-size:14px;font-weight:700;}
  .cust-meta{font-size:11px;color:#94a3b8;}
  .sig-line{margin-top:6px;padding:8px 4px;font-size:11px;color:#475569;border-top:1px dashed #cbd5e1;}
  .totals-section{border-top:3px solid #1e293b;padding-top:12px;margin-top:8px;}
  .totals-title{font-size:15px;font-weight:700;margin-bottom:8px;color:#1e293b;}
  @media print{.no-print{display:none}body{margin:10px}}
</style>
</head><body>
<button class="no-print" onclick="window.print()" style="float:right;padding:6px 16px;background:#1e293b;color:#fff;border:none;border-radius:4px;cursor:pointer;">Print</button>
<h2>PACKING LIST</h2>
<div class="meta">
  Date: ${today}
  ${truck  ? ` &nbsp;|&nbsp; Truck: <strong>${truck}</strong>`   : ''}
  ${region ? ` &nbsp;|&nbsp; Region: <strong>${region}</strong>` : ''}
  &nbsp;|&nbsp; Customers: <strong>${sorted_orders.length}</strong>
</div>

${customer_blocks}

<div class="totals-section">
  <div class="totals-title">GRAND TOTALS — All Items</div>
  <table>
    <thead><tr><th>#</th><th>Item Code</th><th>Description</th><th>Total Qty</th><th>UOM</th></tr></thead>
    <tbody>${total_rows}</tbody>
    <tfoot><tr>
      <td colspan="3" style="text-align:right;">TOTAL</td>
      <td>${grand_qty.toFixed(2)}</td><td>—</td>
    </tr></tfoot>
  </table>
</div>
<p style="margin-top:20px;font-size:10px;color:#888;">Generated: ${today} &nbsp;·&nbsp; Crystal Customs</p>
</body></html>`;

            const w = window.open('', '_blank');
            w.document.write(html);
            w.document.close();
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
        const order       = this.orders.find(o => o.name === order_name);
        const truck_num   = order ? (order.custom_truck_number || '') : '';

        frappe.call({
            method: 'erpnext.selling.doctype.sales_order.sales_order.make_delivery_note',
            args: { source_name: order_name },
            freeze: true,
            freeze_message: __('Preparing Delivery Note…'),
            callback: (r) => {
                if (!r.message) return;
                const doc = r.message;

                const open_form = () => {
                    frappe.model.sync(doc);
                    frappe.set_route('Form', 'Delivery Note', doc.name);
                };

                if (!truck_num) { open_form(); return; }

                // Pre-fill vehicle number from truck assignment
                doc.vehicle_no = truck_num;

                // Fetch saved truck metadata to get driver name
                frappe.call({
                    method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_meta',
                    callback: (meta_r) => {
                        try {
                            const trucks = JSON.parse(meta_r.message || '[]');
                            const truck  = trucks.find(t => t.truck_number === truck_num);
                            if (truck && truck.driver_name) {
                                doc.driver_name = truck.driver_name;
                            }
                        } catch(e) {}
                        open_form();
                    },
                    error: open_form,
                });
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
                .dm-truck-header td {
                    background: #1e293b !important;
                    color: #f1f5f9 !important;
                    font-weight: 700;
                    font-size: 13px;
                    padding: 9px 14px !important;
                    border: none !important;
                }
                .dm-truck-meta { font-weight: 400; color: #94a3b8; margin-left: 10px; font-size: 12px; }
                .dm-selection-bar {
                    display: flex;
                    align-items: center;
                    gap: 16px;
                    padding: 10px 14px;
                    background: #f8fafc;
                    border: 1px solid #e2e8f0;
                    border-radius: 6px;
                    margin-bottom: 12px;
                    font-size: 13px;
                }
                .dm-sel-all-label { display: flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; margin: 0; }
                .dm-sel-count { color: #667eea; font-weight: 600; }
                .dm-row-selected td { background: #eff6ff !important; }
                .order-row { transition: all 0.2s; border-left: 3px solid transparent; }
                .order-row:hover { background-color: #f3f4f6 !important; border-left-color: #667eea; }
                .order-row.order-overdue { background-color: #fef2f2; }
                .order-row td { padding: 10px !important; vertical-align: middle !important; }
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
