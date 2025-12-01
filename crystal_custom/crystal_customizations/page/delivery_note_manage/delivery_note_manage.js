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
        this.filters = {
            regions: [],
            customer: null
        };
        this.orders = [];
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
            options:"Delivery Region",
            change: () => this.apply_filters()
        });

        this.page.add_field({
            label: 'Customer',
            fieldtype: 'Link',
            fieldname: 'customer',
            options: 'Customer',
            change: () => this.apply_filters()
        });

        this.page.add_button('Refresh', () => {
            this.load_data();
        }, 'octicon octicon-sync');

        this.container = $('<div class="delivery-manager-container"></div>').appendTo(this.page.main);
    }

    set_default_dates() {
        const today = frappe.datetime.get_today();
        const yesterday = frappe.datetime.add_days(today, -1);
        
        this.page.fields_dict.from_date.set_value(yesterday);
        this.page.fields_dict.to_date.set_value(today);
    }

    load_data() {
        const from_date = this.page.fields_dict.from_date.get_value();
        const to_date = this.page.fields_dict.to_date.get_value();

        if (!from_date || !to_date) {
            frappe.msgprint(__('Please select both From Date and To Date'));
            return;
        }

        // Show loading indicator
        this.container.html(`
            <div style="text-align: center; padding: 50px;">
                <div class="spinner-border text-primary" role="status">
                    <span class="sr-only">Loading...</span>
                </div>
                <p style="margin-top: 15px; color: #6b7280;">Loading orders...</p>
            </div>
        `);

        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Sales Order',
                fields: ['name', 'customer', 'customer_name', 'transaction_date', 'grand_total', 
                         'custom_delivery_region', 'custom_phone_number', 'delivery_date', 'per_delivered', 'status'],
                filters: [
                    ['Sales Order', 'docstatus', '=', 1],
                    ['Sales Order', 'transaction_date', 'between', [from_date, to_date]],
                    ['Sales Order', 'per_delivered', '<', 100],
                    ['Sales Order', 'status', '!=', 'Closed']
                ],
                order_by: 'transaction_date desc',
                limit_page_length: 500
            },
            callback: (r) => {
                console.log('API Response:', r);
                if (r.message && r.message.length > 0) {
                    console.log('Fetched submitted orders:', r.message);
                    this.orders = r.message;
                } else {
                    console.log('No orders found');
                    this.orders = [];
                }
                this.render_orders();
            },
            error: (r) => {
                console.error('Error loading orders:', r);
                frappe.msgprint({
                    title: __('Error'),
                    message: __('Error loading orders. Please check permissions and try again.'),
                    indicator: 'red'
                });
                this.orders = [];
                this.render_orders();
            }
        });
    }

    apply_filters() {
        const regions = this.page.fields_dict.delivery_region.get_value();
        const customer = this.page.fields_dict.customer.get_value();
        
        this.filters = {
            regions: regions ? regions.split(',').map(r => r.trim()) : [],
            customer: customer
        };
        
        this.render_orders();
    }

    get_filtered_orders() {
        return this.orders.filter(order => {
            if (this.filters.customer && order.customer !== this.filters.customer) {
                return false;
            }
            if (this.filters.regions && this.filters.regions.length > 0 && 
                !this.filters.regions.includes(order.custom_delivery_region)) {
                return false;
            }
            return true;
        });
    }

    render_orders() {
        const filtered_orders = this.get_filtered_orders();
        
        if (filtered_orders.length === 0) {
            this.container.html(`
                <div class="alert alert-info" style="margin-top: 20px;">
                    <strong>No orders found</strong><br>
                    ${this.orders.length > 0 ? 
                        'No orders match your filters. Try adjusting the filters.' : 
                        'No submitted sales orders without delivery notes in the selected date range.'}
                </div>
            `);
            return;
        }

        const total_value = filtered_orders.reduce((sum, o) => sum + o.grand_total, 0);
        const regions = [...new Set(filtered_orders.map(o => o.custom_delivery_region).filter(r => r))];
        
        let html = `
            <div class="delivery-orders-table">
                <div class="summary-card">
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="1" y="3" width="15" height="13"></rect>
                                <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon>
                                <circle cx="5.5" cy="18.5" r="2.5"></circle>
                                <circle cx="18.5" cy="18.5" r="2.5"></circle>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Pending Delivery</div>
                            <div class="summary-value">${filtered_orders.length}</div>
                        </div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);">
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
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"></path>
                                <circle cx="12" cy="10" r="3"></circle>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Regions</div>
                            <div class="summary-value">${regions.length}</div>
                        </div>
                    </div>
                </div>
                
                <div class="table-wrapper">
                    <table class="table table-bordered modern-table">
                        <thead>
                            <tr>
                                <th width="5%"></th>
                                <th width="12%">Sales Order</th>
                                <th width="15%">Customer</th>
                                <th width="12%">Phone</th>
                                <th width="10%">Order Amount</th>
                                <th width="10%">Order Date</th>
                                <th width="10%">Delivery Date</th>
                                <th width="12%">Region</th>
                                <th width="14%">Action</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        filtered_orders.forEach(order => {
            const delivery_date = order.delivery_date || order.transaction_date;
            const is_overdue = delivery_date && frappe.datetime.get_diff(frappe.datetime.get_today(), delivery_date) > 0;
            
            html += `
                <tr class="order-row ${is_overdue ? 'order-overdue' : ''}" data-order="${order.name}">
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
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;">
                                <rect x="1" y="3" width="15" height="13"></rect>
                                <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon>
                                <circle cx="5.5" cy="18.5" r="2.5"></circle>
                                <circle cx="18.5" cy="18.5" r="2.5"></circle>
                            </svg>
                            Create Delivery Note
                        </button>
                    </td>
                </tr>
                <tr class="order-details-row" data-order="${order.name}" style="display:none;">
                    <td colspan="9">
                        <div class="order-details-container" style="padding: 15px; background: #f8f9fa;">
                            <div class="loading">Loading items...</div>
                        </div>
                    </td>
                </tr>
            `;
        });

        html += `
                        </tbody>
                    </table>
                </div>
            </div>
            <style>
                .delivery-orders-table { 
                    margin-top: 20px;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }
                
                .summary-card {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
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
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
                    background-color: #f3f4f6 !important;
                    border-left-color: #667eea;
                }
                
                .order-row.order-overdue {
                    background-color: #fef2f2;
                }
                
                .order-row.order-overdue:hover {
                    background-color: #fee2e2 !important;
                    border-left-color: #dc2626;
                }
                
                .order-row td {
                    padding: 14px 12px !important;
                    vertical-align: middle !important;
                }
                
                .order-link, .customer-link {
                    color: #667eea;
                    font-weight: 600;
                    text-decoration: none;
                    transition: color 0.2s;
                }
                
                .order-link:hover, .customer-link:hover {
                    color: #764ba2;
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
                    background: linear-gradient(135deg, #43e97b15 0%, #38f9d715 100%);
                    color: #059669;
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
                
                .date-normal {
                    color: #059669;
                    font-weight: 600;
                }
                
                .date-overdue {
                    color: #dc2626;
                    font-weight: 700;
                }
                
                .overdue-badge {
                    display: inline-block;
                    margin-left: 8px;
                    padding: 2px 8px;
                    background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);
                    color: white;
                    border-radius: 12px;
                    font-size: 10px;
                    font-weight: 700;
                    letter-spacing: 0.5px;
                }
                
                .btn-create-dn {
                    transition: all 0.2s;
                    font-weight: 600;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    border: none;
                    color: white;
                }
                
                .btn-create-dn:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
                    background: linear-gradient(135deg, #764ba2 0%, #667eea 100%);
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
            </style>
        `;

        this.container.html(html);
        this.attach_events();
    }

    attach_events() {
        const self = this;
        
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

        // Create delivery note button
        this.container.find('.btn-create-dn').off('click').on('click', function() {
            const order_name = $(this).data('order');
            self.create_delivery_note(order_name);
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
                    this.render_order_items($container, order_name, r.message.items);
                }
            }
        });
    }

    render_order_items($container, order_name, items) {
        let html = '<div class="items-list" style="max-width: 100%;">';
        
        items.forEach((item, idx) => {
            html += `
                <div class="item-row">
                    <div class="item-header">${item.item_code} - ${item.item_name || ''}</div>
                    <div class="item-details">
                        <span><strong>Qty:</strong> ${item.qty} ${item.uom || ''}</span>
                        <span><strong>Delivered:</strong> ${item.delivered_qty || 0} ${item.uom || ''}</span>
                        <span><strong>Pending:</strong> ${(item.qty - (item.delivered_qty || 0))} ${item.uom || ''}</span>
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
        method: "erpnext.selling.doctype.sales_order.sales_order.make_delivery_note",
        args: {
            source_name: order_name
        },
        callback: (r) => {
            if (r.message) {
                let dn = r.message;
                
                frappe.call({
                    method: "frappe.client.insert",
                    args: { doc: dn },
                    callback: function(res) {
                        frappe.show_alert({
                            message: __("Draft Delivery Note {0} created", [res.message.name]),
                            indicator: "green"
                        });
                        frappe.set_route("Form", "Delivery Note", res.message.name);
                    },
                    error: function(err) {
                        frappe.msgprint({
                            title: __('Error'),
                            message: __('Failed to create Delivery Note: {0}', [err.message || err]),
                            indicator: 'red'
                        });
                        console.error('Delivery Note creation error:', err);
                    }
                });
            }
        },
        error: function(err) {
            frappe.msgprint({
                title: __('Error'),
                message: __('Failed to fetch Sales Order data: {0}', [err.message || err]),
                indicator: 'red'
            });
            console.error('Sales Order fetch error:', err);
        }
    });
}
}