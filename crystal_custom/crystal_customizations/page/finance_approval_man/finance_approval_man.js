frappe.pages['finance-approval-man'].on_page_load = function(wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Finance Approval Manager',
        single_column: true
    });

    new FinanceApprovalManager(page);
}

class FinanceApprovalManager {
    constructor(page) {
        this.page = page;
        this.filters = {};
        this.orders = [];
        this.customer_financials = {};
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
            label: 'Sales Person',
            fieldtype: 'Link',
            fieldname: 'sales_person',
            options: 'Sales Person',
            change: () => this.apply_filters()
        });

        this.page.set_primary_action('Approve Selected', () => {
            this.approve_selected_orders();
        }, 'octicon octicon-check');

        this.page.add_button('Reject Selected', () => {
            this.reject_selected_orders();
        }, 'octicon octicon-x');

        this.page.add_button('Refresh', () => {
            this.load_data();
        }, 'octicon octicon-sync');

        this.container = $('<div class="finance-approval-container"></div>').appendTo(this.page.main);
    }

    load_data() {
        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Sales Order',
                fields: ['name', 'customer', 'customer_name', 'transaction_date', 'grand_total', 'custom_delivery_region', 'owner', 'workflow_state'],
                filters: {
                    docstatus: 0,
                    workflow_state: 'Pending Finance Approval'
                },
                limit_page_length: 500
            },
            callback: (r) => {
                if (r.message) {
                    console.log('Fetched orders for finance approval:', r.message);
                    this.orders = r.message;
                    this.load_customer_financials();
                }
            }
        });
    }

    load_customer_financials() {
        const customers = [...new Set(this.orders.map(o => o.customer))];
        
        let processed = 0;
        
        customers.forEach(customer => {
            frappe.call({
                method: 'frappe.client.get_value',
                args: {
                    doctype: 'Customer',
                    filters: { name: customer },
                    fieldname: ['credit_limits']
                },
                callback: (r) => {
                    if (!this.customer_financials[customer]) {
                        this.customer_financials[customer] = {
                            credit_limit: 0,
                            outstanding: 0
                        };
                    }
                    
                    frappe.call({
                        method: 'frappe.client.get',
                        args: {
                            doctype: 'Customer',
                            name: customer
                        },
                        callback: (r2) => {
                            if (r2.message && r2.message.credit_limits && r2.message.credit_limits.length > 0) {
                                this.customer_financials[customer].credit_limit = r2.message.credit_limits[0].credit_limit || 0;
                            }
                            
                            this.get_customer_outstanding(customer, () => {
                                processed++;
                                if (processed === customers.length) {
                                    this.render_orders();
                                }
                            });
                        }
                    });
                }
            });
        });
    }

    get_customer_outstanding(customer, callback) {
        frappe.call({
            method: 'erpnext.accounts.utils.get_balance_on',
            args: {
                party_type: 'Customer',
                party: customer
            },
            callback: (r) => {
                if (r.message !== undefined) {
                    this.customer_financials[customer].outstanding = Math.abs(r.message);
                }
                callback();
            },
            error: () => {
                callback();
            }
        });
    }

    apply_filters() {
        this.filters = {
            customer: this.page.fields_dict.customer.get_value(),
            sales_person: this.page.fields_dict.sales_person.get_value()
        };
        this.render_orders();
    }

    get_filtered_orders() {
        return this.orders.filter(order => {
            if (this.filters.customer && order.customer !== this.filters.customer) {
                return false;
            }
            if (this.filters.sales_person && order.owner !== this.filters.sales_person) {
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
                        'No orders match your filters. Try adjusting or clearing the filters.' : 
                        'No sales orders pending finance approval.'}
                </div>
            `);
            return;
        }
        
        let html = `
            <div class="finance-orders-table">
                <div class="summary-card">
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M9 11l3 3L22 4"></path>
                                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"></path>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Pending Approval</div>
                            <div class="summary-value">${filtered_orders.length}</div>
                        </div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <path d="M12 6v6l4 2"></path>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Total Value</div>
                            <div class="summary-value">${format_currency(filtered_orders.reduce((sum, o) => sum + o.grand_total, 0))}</div>
                        </div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"></path>
                                <circle cx="9" cy="7" r="4"></circle>
                                <path d="M23 21v-2a4 4 0 00-3-3.87"></path>
                                <path d="M16 3.13a4 4 0 010 7.75"></path>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Customers</div>
                            <div class="summary-value">${[...new Set(filtered_orders.map(o => o.customer))].length}</div>
                        </div>
                    </div>
                </div>
                
                <div class="table-wrapper">
                    <table class="table table-bordered modern-table">
                        <thead>
                            <tr>
                                <th width="3%">
                                    <input type="checkbox" id="select-all-orders" />
                                </th>
                                <th width="12%">Sales Order</th>
                                <th width="15%">Customer</th>
                                <th width="10%">Order Amount</th>
                                <th width="10%">Credit Limit</th>
                                <th width="10%">Outstanding</th>
                                <th width="10%">Available Credit</th>
                                <th width="10%">Status</th>
                                <th width="10%">Date</th>
                                <th width="10%">Region</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        filtered_orders.forEach(order => {
            const financials = this.customer_financials[order.customer] || { credit_limit: 0, outstanding: 0 };
            const available_credit = financials.credit_limit - financials.outstanding;
            const new_total = financials.outstanding + order.grand_total;
            const exceeds_limit = new_total > financials.credit_limit;
            
            html += `
                <tr class="order-row" data-order="${order.name}">
                    <td>
                        <input type="checkbox" class="order-checkbox" data-order="${order.name}" />
                    </td>
                    <td><a href="/app/sales-order/${order.name}" target="_blank" class="order-link">${order.name}</a></td>
                    <td><a href="/app/customer/${order.customer}" target="_blank" class="customer-link">${order.customer_name || order.customer}</a></td>
                    <td><span class="amount-badge amount-order">${format_currency(order.grand_total)}</span></td>
                    <td><span class="amount-badge amount-limit">${format_currency(financials.credit_limit)}</span></td>
                    <td><span class="amount-badge ${financials.outstanding > 0 ? 'amount-outstanding' : 'amount-clear'}">${format_currency(financials.outstanding)}</span></td>
                    <td><span class="amount-badge ${available_credit < order.grand_total ? 'amount-low' : 'amount-available'}">${format_currency(available_credit)}</span></td>
                    <td>
                        ${exceeds_limit ? 
                            '<span class="status-badge status-warning">⚠ Exceeds Limit</span>' : 
                            '<span class="status-badge status-ok">✓ Within Limit</span>'}
                    </td>
                    <td>${frappe.datetime.str_to_user(order.transaction_date)}</td>
                    <td><span class="region-tag">${order.custom_delivery_region || '-'}</span></td>
                </tr>
            `;
        });

        html += `
                        </tbody>
                    </table>
                </div>
            </div>
            <style>
                .finance-orders-table { 
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
                    transition: background-color 0.2s;
                    border-left: 3px solid transparent;
                }
                
                .order-row:hover { 
                    background-color: #f9fafb !important;
                    border-left-color: #667eea;
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
                
                .amount-badge {
                    display: inline-block;
                    padding: 6px 12px;
                    border-radius: 6px;
                    font-weight: 600;
                    font-size: 13px;
                }
                
                .amount-order {
                    background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%);
                    color: #667eea;
                }
                
                .amount-limit {
                    background: linear-gradient(135deg, #4facfe15 0%, #00f2fe15 100%);
                    color: #0891b2;
                }
                
                .amount-outstanding {
                    background: linear-gradient(135deg, #f093fb15 0%, #f5576c15 100%);
                    color: #dc2626;
                }
                
                .amount-clear {
                    background: linear-gradient(135deg, #43e97b15 0%, #38f9d715 100%);
                    color: #059669;
                }
                
                .amount-available {
                    background: linear-gradient(135deg, #43e97b15 0%, #38f9d715 100%);
                    color: #059669;
                    font-weight: 700;
                }
                
                .amount-low {
                    background: linear-gradient(135deg, #fa709a15 0%, #fee14015 100%);
                    color: #ea580c;
                    font-weight: 700;
                }
                
                .status-badge {
                    display: inline-block;
                    padding: 6px 12px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                
                .status-ok {
                    background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
                    color: white;
                }
                
                .status-warning {
                    background: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
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
                
                input[type="checkbox"] {
                    width: 18px;
                    height: 18px;
                    cursor: pointer;
                    accent-color: #667eea;
                }
            </style>
        `;

        this.container.html(html);
        this.attach_events();
    }

    attach_events() {
        const self = this;
        
        $('#select-all-orders').off('change').on('change', function() {
            $('.order-checkbox').prop('checked', $(this).prop('checked'));
        });
    }

    get_selected_orders() {
        const selected = [];
        $('.order-checkbox:checked').each(function() {
            selected.push($(this).data('order'));
        });
        return selected;
    }

    approve_selected_orders() {
        const selected = this.get_selected_orders();
        
        if (selected.length === 0) {
            frappe.msgprint(__('Please select at least one order to approve'));
            return;
        }

        frappe.confirm(
            __('Approve {0} selected order(s) and move to Pending Customer Order Reconfirmation?', [selected.length]),
            () => {
                this.process_approvals(selected);
            }
        );
    }

    reject_selected_orders() {
        const selected = this.get_selected_orders();
        
        if (selected.length === 0) {
            frappe.msgprint(__('Please select at least one order to reject'));
            return;
        }

        frappe.prompt(
            {
                label: 'Rejection Reason',
                fieldname: 'reason',
                fieldtype: 'Small Text',
                reqd: 1
            },
            (values) => {
                frappe.confirm(
                    __('Reject {0} selected order(s)?', [selected.length]),
                    () => {
                        this.process_rejections(selected, values.reason);
                    }
                );
            },
            __('Rejection Reason'),
            __('Reject Orders')
        );
    }

    process_approvals(order_list) {
        let processed = 0;
        let errors = [];

        const process_next = () => {
            if (processed >= order_list.length) {
                if (errors.length > 0) {
                    frappe.msgprint({
                        title: __('Approval Complete with Errors'),
                        message: __('Successfully approved {0} orders. {1} failed:<br>{2}', 
                            [order_list.length - errors.length, errors.length, errors.join('<br>')]),
                        indicator: 'orange'
                    });
                } else {
                    frappe.msgprint({
                        title: __('Success'),
                        message: __('All {0} orders approved and moved to Pending Customer Order Reconfirmation', [order_list.length]),
                        indicator: 'green'
                    });
                }
                this.load_data();
                return;
            }

            const order_name = order_list[processed];
            
            frappe.call({
                method: 'frappe.client.set_value',
                args: {
                    doctype: 'Sales Order',
                    name: order_name,
                    fieldname: 'workflow_state',
                    value: 'Pending Customer Order Reconfirmation'
                },
                callback: (r) => {
                    if (r.message) {
                        frappe.show_alert({
                            message: __('Approved {0}', [order_name]),
                            indicator: 'green'
                        });
                    }
                    processed++;
                    if (!r.message) {
                        errors.push(order_name);
                    }
                    process_next();
                },
                error: () => {
                    processed++;
                    errors.push(order_name);
                    process_next();
                }
            });
        };

        frappe.show_alert({
            message: __('Approving orders...'),
            indicator: 'blue'
        });

        process_next();
    }

    process_rejections(order_list, reason) {
        let processed = 0;
        let errors = [];

        const process_next = () => {
            if (processed >= order_list.length) {
                if (errors.length > 0) {
                    frappe.msgprint({
                        title: __('Rejection Complete with Errors'),
                        message: __('Successfully rejected {0} orders. {1} failed:<br>{2}', 
                            [order_list.length - errors.length, errors.length, errors.join('<br>')]),
                        indicator: 'orange'
                    });
                } else {
                    frappe.msgprint({
                        title: __('Success'),
                        message: __('All {0} orders rejected', [order_list.length]),
                        indicator: 'green'
                    });
                }
                this.load_data();
                return;
            }

            const order_name = order_list[processed];
            
            frappe.call({
                method: 'frappe.desk.form.utils.add_comment',
                args: {
                    reference_doctype: 'Sales Order',
                    reference_name: order_name,
                    content: `Finance Rejection: ${reason}`,
                    comment_email: frappe.session.user,
                    comment_by: frappe.session.user_fullname
                },
                callback: () => {
                    frappe.call({
                        method: 'frappe.client.set_value',
                        args: {
                            doctype: 'Sales Order',
                            name: order_name,
                            fieldname: 'workflow_state',
                            value: 'Proceed To Order'
                        },
                        callback: (r) => {
                            if (r.message) {
                                frappe.show_alert({
                                    message: __('Rejected {0}', [order_name]),
                                    indicator: 'red'
                                });
                            }
                            processed++;
                            if (!r.message) {
                                errors.push(order_name);
                            }
                            process_next();
                        },
                        error: () => {
                            processed++;
                            errors.push(order_name);
                            process_next();
                        }
                    });
                }
            });
        };

        frappe.show_alert({
            message: __('Rejecting orders...'),
            indicator: 'orange'
        });

        process_next();
    }
}