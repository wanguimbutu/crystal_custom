frappe.pages['customer-order-confi'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Customer Order Confirmation',
		single_column: true
	});
	new OrderConfirmationManager(page);
}

class OrderConfirmationManager {
    constructor(page) {
        this.page = page;
        this.filters = {};
        this.orders = [];
        this.called_orders = new Set();
        this.not_picked_orders = new Set();
        this.current_page = 1;
        this.page_size = 50;
        this.setup_page();
        this.load_data();
    }

    setup_page() {
        this.page.add_field({
            label: 'Customer',
            fieldtype: 'Link',
            fieldname: 'customer',
            options: 'Customer',
            change: () => this.apply_filters()
        });

        this.page.add_field({
            label: 'Delivery Region',
            fieldtype: 'Link',
            fieldname: 'delivery_region',
            options: 'Delivery Region',
            change: () => this.apply_filters()
        });

        this.page.add_field({
            label: 'Sales Person',
            fieldtype: 'Link',
            fieldname: 'sales_person',
            options: 'Sales Person',
            change: () => { this.current_page = 1; this.load_data(); }
        });

        this.page.add_field({
            label: 'Status',
            fieldtype: 'Select',
            fieldname: 'status_filter',
            options: '\nAll\nPending Call\nCalled\nNot Picked',
            default: 'All',
            change: () => this.apply_filters()
        });

        this.page.set_primary_action('Submit Called Orders', () => {
            this.submit_orders(Array.from(this.called_orders), 'called');
        }, 'octicon octicon-check');

        this.page.add_button('Submit Not Picked Orders', () => {
            this.submit_orders(Array.from(this.not_picked_orders), 'not picked');
        }, 'octicon octicon-arrow-right');

        this.page.add_button('Refresh', () => {
            this.load_data();
        }, 'octicon octicon-sync');

        this.container = $('<div class="order-confirmation-container"></div>').appendTo(this.page.main);
    }

    load_data() {
        const sp = this.page.fields_dict.sales_person.get_value();
        const filters = [
            ['Sales Order', 'docstatus', '=', 0],
            ['Sales Order', 'workflow_state', '=', 'Pending Customer Order Reconfirmation'],
        ];
        if (sp) filters.push(['Sales Team', 'sales_person', '=', sp]);

        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Sales Order',
                fields: ['name', 'customer', 'customer_name', 'transaction_date', 'grand_total',
                         'custom_delivery_region', 'custom_phone_number', 'owner', 'workflow_state',
                         'custom_call_not_picked', 'custom_call_notes'],
                filters,
                limit_page_length: 500
            },
            callback: (r) => {
                if (r.message) {
                    this.orders = r.message;
                    
                    // Restore state for orders that were marked as not picked
                    this.orders.forEach(order => {
                        if (order.custom_call_not_picked === 1) {
                            this.not_picked_orders.add(order.name);
                        }
                    });
                    
                    this.render_orders();
                }
            }
        });
    }

    apply_filters() {
        this.filters = {
            customer: this.page.fields_dict.customer.get_value(),
            delivery_region: this.page.fields_dict.delivery_region.get_value(),
            status: this.page.fields_dict.status_filter.get_value()
        };
        this.current_page = 1;
        this.render_orders();
    }

    get_filtered_orders() {
        return this.orders.filter(order => {
            if (this.filters.customer && order.customer !== this.filters.customer) {
                return false;
            }
            if (this.filters.delivery_region && order.custom_delivery_region !== this.filters.delivery_region) {
                return false;
            }
            if (this.filters.status && this.filters.status !== 'All') {
                const is_called = this.called_orders.has(order.name);
                const is_not_picked = this.not_picked_orders.has(order.name);
                
                if (this.filters.status === 'Pending Call' && (is_called || is_not_picked)) {
                    return false;
                }
                if (this.filters.status === 'Called' && !is_called) {
                    return false;
                }
                if (this.filters.status === 'Not Picked' && !is_not_picked) {
                    return false;
                }
            }
            return true;
        });
    }

    render_orders() {
        const all_filtered = this.get_filtered_orders();
        const total_pages = Math.ceil(all_filtered.length / this.page_size) || 1;
        if (this.current_page > total_pages) this.current_page = total_pages;
        const filtered_orders = all_filtered.slice(
            (this.current_page - 1) * this.page_size,
            this.current_page * this.page_size
        );

        if (all_filtered.length === 0) {
            this.container.html(`
                <div class="alert alert-info" style="margin-top: 20px;">
                    <strong>No orders found</strong><br>
                    ${this.orders.length > 0 ? 
                        'No orders match your filters. Try adjusting or clearing the filters.' : 
                        'No sales orders pending customer reconfirmation.'}
                </div>
            `);
            return;
        }

        const total_value = all_filtered.reduce((sum, o) => sum + o.grand_total, 0);
        const called_count = all_filtered.filter(o => this.called_orders.has(o.name)).length;
        const not_picked_count = all_filtered.filter(o => this.not_picked_orders.has(o.name)).length;
        const pending_count = all_filtered.filter(o =>
            !this.called_orders.has(o.name) && !this.not_picked_orders.has(o.name)
        ).length;
        
        let html = `
            <div class="confirmation-orders-table">
                <div class="summary-card">
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"></path>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Pending Calls</div>
                            <div class="summary-value">${pending_count}</div>
                        </div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 11.08V12a10 10 0 11-5.93-9.14"></path>
                                <polyline points="22 4 12 14.01 9 11.01"></polyline>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Called</div>
                            <div class="summary-value">${called_count}</div>
                        </div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path>
                                <line x1="12" y1="9" x2="12" y2="13"></line>
                                <line x1="12" y1="17" x2="12.01" y2="17"></line>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Not Picked</div>
                            <div class="summary-value">${not_picked_count}</div>
                        </div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="12" y1="1" x2="12" y2="23"></line>
                                <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"></path>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Total Value</div>
                            <div class="summary-value">${format_currency(total_value)}</div>
                        </div>
                    </div>
                </div>
                
                <div class="table-wrapper">
                    <table class="table table-bordered modern-table">
                        <thead>
                            <tr>
                                <th width="4%"></th>
                                <th width="11%">Sales Order</th>
                                <th width="13%">Customer</th>
                                <th width="11%">Phone Number</th>
                                <th width="9%">Amount</th>
                                <th width="8%">Date</th>
                                <th width="10%">Region</th>
                                <th width="20%">Action</th>
                                <th width="10%">Status</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        filtered_orders.forEach(order => {
            const is_called = this.called_orders.has(order.name);
            const is_not_picked = this.not_picked_orders.has(order.name);
            
            html += `
                <tr class="order-row ${is_called ? 'order-called' : ''} ${is_not_picked ? 'order-not-picked' : ''}" 
                    data-order="${order.name}">
                    <td>
                        <span class="toggle-details" style="cursor:pointer; font-size: 16px;">▶</span>
                    </td>
                    <td><a href="/app/sales-order/${order.name}" target="_blank" class="order-link">${order.name}</a></td>
                    <td><a href="/app/customer/${order.customer}" target="_blank" class="customer-link">${order.customer_name || order.customer}</a></td>
                    <td>
                        ${order.custom_phone_number ? 
                            `<a href="tel:${order.custom_phone_number}" class="phone-link">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;">
                                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"></path>
                                </svg>
                                ${order.custom_phone_number}
                            </a>` : 
                            '<span class="text-muted">No phone</span>'}
                    </td>
                    <td><span class="amount-badge">${format_currency(order.grand_total)}</span></td>
                    <td>${frappe.datetime.str_to_user(order.transaction_date)}</td>
                    <td><span class="region-tag">${order.custom_delivery_region || '-'}</span></td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn btn-sm ${is_called ? 'btn-success' : 'btn-primary'} btn-mark-called" 
                                    data-order="${order.name}"
                                    ${is_called ? 'disabled' : ''}>
                                ${is_called ? '✓ Called' : 'Mark Called'}
                            </button>
                            <button class="btn btn-sm ${is_not_picked ? 'btn-danger' : 'btn-warning'} btn-not-picked" 
                                    data-order="${order.name}"
                                    ${is_called ? 'disabled' : ''}>
                                ${is_not_picked ? '✓ Not Picked' : 'Not Picked'}
                            </button>
                        </div>
                    </td>
                    <td>
                        ${is_called ? 
                            '<span class="status-badge status-called">Ready to Submit</span>' : 
                            is_not_picked ?
                            '<span class="status-badge status-not-picked">Call Not Picked</span>' :
                            '<span class="status-badge status-pending">Pending Call</span>'}
                    </td>
                </tr>
                <tr class="order-details-row" data-order="${order.name}" style="display:none;">
                    <td colspan="9">
                        <div class="order-details-container" style="padding: 15px; background: #f8f9fa;">
                            <div class="loading">Loading details...</div>
                        </div>
                    </td>
                </tr>
            `;
        });

        html += `
                        </tbody>
                    </table>
                    ${this._pagination_html(all_filtered.length)}
                </div>
            </div>
            <style>
                .confirmation-orders-table { 
                    margin-top: 20px;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }
                
                .summary-card {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }
                
                .summary-item {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    display: flex;
                    align-items: center;
                    gap: 15px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                    transition: transform 0.2s, box-shadow 0.2s;
                }
                
                .summary-item:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 4px 12px rgba(0,0,0,0.12);
                }
                
                .summary-icon {
                    width: 50px;
                    height: 50px;
                    border-radius: 10px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    flex-shrink: 0;
                }
                
                .summary-content {
                    flex-grow: 1;
                }
                
                .summary-label {
                    font-size: 13px;
                    color: #6b7280;
                    margin-bottom: 4px;
                    font-weight: 500;
                }
                
                .summary-value {
                    font-size: 24px;
                    font-weight: 700;
                    color: #111827;
                }
                
                .table-wrapper {
                    background: white;
                    border-radius: 12px;
                    overflow: hidden;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                }
                
                .modern-table {
                    margin-bottom: 0 !important;
                }
                
                .modern-table thead {
                    background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
                }
                
                .modern-table thead th {
                    color: white !important;
                    font-weight: 600;
                    text-transform: uppercase;
                    font-size: 12px;
                    letter-spacing: 0.5px;
                    padding: 16px 12px !important;
                    border: none !important;
                }
                
                .order-row {
                    transition: all 0.2s;
                    border-left: 3px solid transparent;
                }
                
                .order-row:hover { 
                    background-color: #fef2f2 !important;
                    border-left-color: #f093fb;
                }
                
                .order-row.order-called {
                    background-color: #f0fdf4;
                }
                
                .order-row.order-called:hover {
                    background-color: #dcfce7 !important;
                    border-left-color: #43e97b;
                }
                
                .order-row.order-not-picked {
                    background-color: #fef2f2;
                }
                
                .order-row.order-not-picked:hover {
                    background-color: #fee2e2 !important;
                    border-left-color: #ef4444;
                }
                
                .order-row td {
                    padding: 14px 12px !important;
                    vertical-align: middle !important;
                }
                
                .action-buttons {
                    display: flex;
                    gap: 5px;
                    flex-wrap: wrap;
                }
                
                .action-buttons .btn {
                    font-size: 11px;
                    padding: 4px 10px;
                }
                
                .order-link, .customer-link {
                    color: #f093fb;
                    font-weight: 600;
                    text-decoration: none;
                    transition: color 0.2s;
                }
                
                .order-link:hover, .customer-link:hover {
                    color: #f5576c;
                    text-decoration: underline;
                }
                
                .phone-link {
                    color: #0891b2;
                    font-weight: 600;
                    text-decoration: none;
                    transition: color 0.2s;
                    display: inline-flex;
                    align-items: center;
                }
                
                .phone-link:hover {
                    color: #0e7490;
                    text-decoration: underline;
                }
                
                .amount-badge {
                    display: inline-block;
                    padding: 6px 12px;
                    border-radius: 6px;
                    font-weight: 600;
                    font-size: 13px;
                    background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%);
                    color: #667eea;
                }
                
                .status-badge {
                    display: inline-block;
                    padding: 6px 12px;
                    border-radius: 20px;
                    font-size: 11px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                
                .status-called {
                    background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
                    color: white;
                }
                
                .status-pending {
                    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
                    color: white;
                }
                
                .status-not-picked {
                    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                    color: white;
                }
                
                .region-tag {
                    display: inline-block;
                    padding: 4px 10px;
                    background: #f3f4f6;
                    border-radius: 6px;
                    font-size: 12px;
                    color: #4b5563;
                    font-weight: 500;
                }
                
                .btn-mark-called, .btn-not-picked {
                    transition: all 0.2s;
                    font-weight: 600;
                }
                
                .btn-mark-called:not(:disabled):hover,
                .btn-not-picked:not(:disabled):hover {
                    transform: translateY(-1px);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                }
                
                .toggle-details {
                    cursor: pointer;
                    transition: transform 0.2s;
                }
                
                .item-row { 
                    margin-bottom: 10px; 
                    padding: 12px; 
                    border: 1px solid #e5e7eb; 
                    border-radius: 8px;
                    background: white;
                }
                
                .item-header { 
                    font-weight: 600; 
                    margin-bottom: 8px;
                    color: #111827;
                    font-size: 14px;
                }
                
                .item-details { 
                    display: flex; 
                    gap: 20px; 
                    flex-wrap: wrap;
                    font-size: 13px;
                    color: #6b7280;
                }
                
                .item-details > span {
                    display: inline-block;
                }
                
                .item-details strong {
                    color: #374151;
                }
                
                .notes-section {
                    margin-top: 15px;
                    padding-top: 15px;
                    border-top: 2px solid #e5e7eb;
                }
                
                .notes-section h4 {
                    font-size: 14px;
                    font-weight: 600;
                    color: #111827;
                    margin-bottom: 10px;
                }
                
                .notes-display {
                    background: white;
                    padding: 10px;
                    border-radius: 6px;
                    border: 1px solid #e5e7eb;
                    color: #6b7280;
                    font-size: 13px;
                    font-style: italic;
                }
                .oc-pg-bar {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 14px;
                    padding: 12px 16px;
                    border-top: 1px solid #e5e7eb;
                    background: #f9fafb;
                }
                .oc-pg-info { font-size: 13px; color: #6b7280; }
                .oc-pg-bar .btn { min-width: 70px; }
            </style>
        `;

        this.container.html(html);
        this.attach_events();
    }

    _pagination_html(total) {
        if (total <= this.page_size) return '';
        const total_pages = Math.ceil(total / this.page_size);
        const start = (this.current_page - 1) * this.page_size + 1;
        const end   = Math.min(this.current_page * this.page_size, total);
        return `<div class="oc-pg-bar">
            <button class="btn btn-xs btn-default oc-pg-prev" ${this.current_page <= 1 ? 'disabled' : ''}>&lsaquo; Prev</button>
            <span class="oc-pg-info">Showing ${start}–${end} of ${total} &nbsp;·&nbsp; Page ${this.current_page} of ${total_pages}</span>
            <button class="btn btn-xs btn-default oc-pg-next" ${this.current_page >= total_pages ? 'disabled' : ''}>Next &rsaquo;</button>
        </div>`;
    }

    attach_events() {
        const self = this;

        // Pagination
        this.container.find('.oc-pg-prev').on('click', () => {
            if (this.current_page > 1) { this.current_page--; this.render_orders(); }
        });
        this.container.find('.oc-pg-next').on('click', () => {
            const tp = Math.ceil(this.get_filtered_orders().length / this.page_size);
            if (this.current_page < tp) { this.current_page++; this.render_orders(); }
        });

        // Toggle details
        this.container.find('.toggle-details').off('click').on('click', function(e) {
            e.stopPropagation();
            const $icon = $(this);
            const order_name = $icon.closest('tr').data('order');
            const $details_row = $(`.order-details-row[data-order="${order_name}"]`);
            
            if ($details_row.is(':visible')) {
                $details_row.hide();
                $icon.text('▶');
            } else {
                $details_row.show();
                $icon.text('▼');
                self.load_order_items(order_name);
            }
        });

        // Mark as called
        this.container.find('.btn-mark-called').off('click').on('click', function() {
            const order_name = $(this).data('order');
            self.mark_as_called(order_name, $(this));
        });

        // Mark as not picked
        this.container.find('.btn-not-picked').off('click').on('click', function() {
            const order_name = $(this).data('order');
            self.mark_as_not_picked(order_name, $(this));
        });
    }

    load_order_items(order_name) {
        const $container = $(`.order-details-row[data-order="${order_name}"] .order-details-container`);
        
        frappe.call({
            method: 'frappe.client.get',
            args: {
                doctype: 'Sales Order',
                name: order_name
            },
            callback: (r) => {
                if (r.message) {
                    this.render_order_items($container, order_name, r.message.items, r.message.custom_call_notes);
                }
            }
        });
    }

    render_order_items($container, order_name, items, call_notes) {
        let html = '<div class="items-list" style="max-width: 100%;">';
        
        items.forEach((item, idx) => {
            html += `
                <div class="item-row">
                    <div class="item-header">${item.item_code} - ${item.item_name || ''}</div>
                    <div class="item-details">
                        <span><strong>Qty:</strong> ${item.qty} ${item.uom || ''}</span>
                        <span><strong>Rate:</strong> ${format_currency(item.rate)}</span>
                        <span><strong>Amount:</strong> ${format_currency(item.amount)}</span>
                        ${item.weight_per_unit ? `<span><strong>Weight:</strong> ${item.weight_per_unit} ${item.weight_uom || 'kg'}</span>` : ''}
                        ${item.weight_per_unit ? `<span><strong>Total Weight:</strong> ${(item.weight_per_unit * item.qty).toFixed(2)} ${item.weight_uom || 'kg'}</span>` : ''}
                    </div>
                </div>
            `;
        });
        
        html += '</div>';
        
        // Add notes section if order has notes
        if (call_notes) {
            html += `
                <div class="notes-section">
                    <h4>📝 Call Notes</h4>
                    <div class="notes-display">${call_notes}</div>
                </div>
            `;
        }
        
        $container.html(html);
    }

    mark_as_called(order_name, $btn) {
        // If order was previously marked as not picked, clear that status
        const was_not_picked = this.not_picked_orders.has(order_name);
        
        if (was_not_picked) {
            // Clear the not picked status in database
            frappe.call({
                method: 'frappe.client.set_value',
                args: {
                    doctype: 'Sales Order',
                    name: order_name,
                    fieldname: {
                        custom_call_not_picked: 0,
                        custom_call_notes: ''
                    }
                },
                callback: (r) => {
                    if (r.message) {
                        this.not_picked_orders.delete(order_name);
                        this.complete_call_marking(order_name, $btn);
                    }
                }
            });
        } else {
            this.complete_call_marking(order_name, $btn);
        }
    }

    complete_call_marking(order_name, $btn) {
        this.called_orders.add(order_name);
        
        $btn.removeClass('btn-primary').addClass('btn-success')
            .text('✓ Called')
            .prop('disabled', true);
        
        // Disable "Not Picked" button
        $btn.closest('.action-buttons').find('.btn-not-picked')
            .removeClass('btn-danger')
            .addClass('btn-warning')
            .text('Not Picked')
            .prop('disabled', true);
        
        $(`.order-row[data-order="${order_name}"]`)
            .removeClass('order-not-picked')
            .addClass('order-called')
            .find('.status-badge')
            .removeClass('status-pending status-not-picked')
            .addClass('status-called')
            .text('Ready to Submit');
        
        frappe.show_alert({
            message: __('Order marked as called'),
            indicator: 'green'
        });
    }

    mark_as_not_picked(order_name, $btn) {
        frappe.prompt([
            {
                label: 'Notes',
                fieldname: 'call_notes',
                fieldtype: 'Small Text',
                description: 'Optional: Add notes about why the call was not picked'
            }
        ],
        (values) => {
            this.not_picked_orders.add(order_name);
            
            // Update the order in database
            frappe.call({
                method: 'frappe.client.set_value',
                args: {
                    doctype: 'Sales Order',
                    name: order_name,
                    fieldname: {
                        custom_call_not_picked: 1,
                        custom_call_notes: values.call_notes || ''
                    }
                },
                callback: (r) => {
                    if (r.message) {
                        $btn.removeClass('btn-warning').addClass('btn-danger')
                            .text('✓ Not Picked')
                            .prop('disabled', true);
                        
                        // Disable "Mark Called" button
                        $btn.closest('.action-buttons').find('.btn-mark-called').prop('disabled', true);
                        
                        $(`.order-row[data-order="${order_name}"]`)
                            .removeClass('order-called')
                            .addClass('order-not-picked')
                            .find('.status-badge')
                            .removeClass('status-pending status-called')
                            .addClass('status-not-picked')
                            .text('Call Not Picked');
                        
                        frappe.show_alert({
                            message: __('Order marked as not picked'),
                            indicator: 'orange'
                        });
                    }
                }
            });
        },
        __('Call Not Picked - Add Notes'),
        __('Save')
        );
    }

    submit_orders(order_list, label) {
        if (!order_list.length) {
            frappe.msgprint(__('No {0} orders to submit.', [label]));
            return;
        }
        frappe.confirm(
            __('Submit {0} {1} order(s) and move to Order Confirmed?', [order_list.length, label]),
            () => this.process_confirmations(order_list)
        );
    }

    process_confirmations(order_list) {
        let processed = 0;
        let errors = [];

        const process_next = () => {
            if (processed >= order_list.length) {
                if (errors.length > 0) {
                    frappe.msgprint({
                        title: __('Confirmation Complete with Errors'),
                        message: __('Successfully confirmed {0} orders. {1} failed:<br>{2}', 
                            [order_list.length - errors.length, errors.length, errors.join('<br>')]),
                        indicator: 'orange'
                    });
                } else {
                    frappe.msgprint({
                        title: __('Success'),
                        message: __('All {0} orders confirmed and submitted', [order_list.length]),
                        indicator: 'green'
                    });
                }
                this.called_orders.clear();
                this.load_data();
                return;
            }

            const order_name = order_list[processed];
            
            // Use frappe.xcall to properly submit the document
            frappe.call({
                method: 'frappe.client.get',
                args: {
                    doctype: 'Sales Order',
                    name: order_name
                },
                callback: (r) => {
                    if (!r.message) {
                        console.error('Failed to get order:', order_name);
                        errors.push(order_name + ' (failed to load)');
                        processed++;
                        process_next();
                        return;
                    }

                    const doc = r.message;
                    console.log('Processing order:', order_name, 'Current docstatus:', doc.docstatus);
                    
                    // Update workflow state
                    doc.workflow_state = 'Order Confirmed';
                    
                    // Save first
                    frappe.call({
                        method: 'frappe.client.save',
                        args: {
                            doc: doc
                        },
                        callback: (r2) => {
                            if (!r2.message) {
                                console.error('Save failed for:', order_name);
                                errors.push(order_name + ' (save failed)');
                                processed++;
                                process_next();
                                return;
                            }

                            console.log('Saved order:', order_name, 'Now submitting...');
                            
                            // Now submit using the saved document
                            frappe.call({
                                method: 'frappe.client.submit',
                                args: {
                                    doc: r2.message
                                },
                                callback: (r3) => {
                                    if (r3.message) {
                                        console.log('Successfully submitted:', order_name);
                                        frappe.show_alert({
                                            message: __('✓ Confirmed & Submitted {0}', [order_name]),
                                            indicator: 'green'
                                        });
                                    } else {
                                        console.error('Submit returned no message for:', order_name);
                                        errors.push(order_name + ' (submit returned empty)');
                                    }
                                    processed++;
                                    process_next();
                                },
                                error: (err) => {
                                    console.error('Submit error for', order_name, ':', err);
                                    const error_msg = err.exc || err.message || err._server_messages || 'Unknown error';
                                    errors.push(order_name + ' (submit failed: ' + error_msg + ')');
                                    processed++;
                                    process_next();
                                }
                            });
                        },
                        error: (err) => {
                            console.error('Save error for', order_name, ':', err);
                            const error_msg = err.exc || err.message || err._server_messages || 'Unknown error';
                            errors.push(order_name + ' (save failed: ' + error_msg + ')');
                            processed++;
                            process_next();
                        }
                    });
                },
                error: (err) => {
                    console.error('Get error for', order_name, ':', err);
                    errors.push(order_name + ' (failed to load)');
                    processed++;
                    process_next();
                }
            });
        };

        frappe.show_alert({
            message: __('Confirming and submitting {0} orders...', [order_list.length]),
            indicator: 'blue'
        });

        process_next();
    }
}