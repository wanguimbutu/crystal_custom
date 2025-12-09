frappe.pages['sales-order-manager'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Sales Order Manager',
		single_column: true
	});

	new DraftSalesOrdersManager(page);
}
class DraftSalesOrdersManager {
    constructor(page) {
        this.page = page;
        this.filters = {};
        this.orders = [];
        this.modified_orders = new Set();
        this.selected_orders = new Set();
        this.held_orders = new Set();
        this.setup_page();
        this.load_data();
    }

    setup_page() {
        this.page.add_field({ label: 'Delivery Region', fieldtype: 'Link', fieldname: 'delivery_region', options: 'Delivery Region', change: () => this.apply_filters() });
        this.page.add_field({ label: 'Sales Person', fieldtype: 'Link', fieldname: 'sales_person', options: 'Sales Person', change: () => this.apply_filters() });

        this.page.set_primary_action('Submit Selected to Finance', () => this.submit_selected_orders(), 'octicon octicon-check');

        this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');
        this.page.add_button('View Truck Assignment', () => frappe.set_route('sales-order-truck-as'), 'octicon octicon-package');

        this.container = $('<div class="draft-orders-container enhanced-ui"></div>').appendTo(this.page.main);
    }

    load_data() {
        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Sales Order',
                fields: ['name', 'customer', 'customer_name', 'transaction_date', 'grand_total', 'custom_delivery_region', 'owner', 'workflow_state', 'custom_on_hold'],
                filters: { docstatus: 0 },
                limit_page_length: 500
            },
            callback: (r) => {
                if (r.message) {
                    this.orders = r.message.filter(order => !order.workflow_state || ['','Proceed To Order',null].includes(order.workflow_state));
                    this.render_orders();
                }
            }
        });
    }

    apply_filters() {
        this.filters = {
            delivery_region: this.page.fields_dict.delivery_region.get_value(),
            sales_person: this.page.fields_dict.sales_person.get_value()
        };
        this.render_orders();
    }

    get_filtered_orders() {
        return this.orders.filter(order => {
            if (this.filters.delivery_region && order.custom_delivery_region !== this.filters.delivery_region) return false;
            if (this.filters.sales_person && order.owner !== this.filters.sales_person) return false;
            return true;
        });
    }

    render_orders() {
        const filtered_orders = this.get_filtered_orders();

        if (filtered_orders.length === 0) {
            this.container.html(`
                <div class="alert alert-info ui-box">
                    <strong>No orders found</strong><br>
                    ${this.orders.length > 0 ? 'Try adjusting your filters.' : 'No draft sales orders available.'}
                </div>
            `);
            return;
        }

        let html = `
            <div class="orders-table ui-box">
                <div class="table-header-bar">
                    <strong>Showing ${filtered_orders.length} of ${this.orders.length} orders</strong>
                    <span class="selected-count">(${this.selected_orders.size} selected)</span>
                    <label class="select-all-wrapper">
                        <input type="checkbox" class="select-all-checkbox"> Select All
                    </label>
                </div>
                <table class="table table-hover enhanced-table">
                    <thead>
                        <tr>
                            <th></th>
                            <th></th>
                            <th>Sales Order</th>
                            <th>Customer</th>
                            <th>Date</th>
                            <th>Region</th>
                            <th>Sales Person</th>
                            <th>Total</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        filtered_orders.forEach(order => {
            const modified = this.modified_orders.has(order.name);
            const selected = this.selected_orders.has(order.name);
            const onHold = order.custom_on_hold === 1;

            html += `
                <tr class="order-row ${modified ? 'row-modified' : ''} ${onHold ? 'row-hold' : ''}" data-order="${order.name}">
                    <td><input type="checkbox" class="order-checkbox" data-order="${order.name}" ${selected ? 'checked' : ''} ${onHold ? 'disabled' : ''}></td>
                    <td><span class="toggle-details">▶</span></td>
                    <td><a href="/app/sales-order/${order.name}" class="order-link" target="_blank">${order.name}</a></td>
                    <td>${order.customer_name || order.customer}</td>
                    <td>${frappe.datetime.str_to_user(order.transaction_date)}</td>
                    <td><span class="badge badge-region">${order.custom_delivery_region || ''}</span></td>
                    <td>${order.owner}</td>
                    <td><span class="badge badge-total">${format_currency(order.grand_total)}</span></td>
                    <td>
                        ${onHold ? '<span class="badge badge-hold">ON HOLD</span>' :
                          modified ? '<span class="badge badge-modified">Modified</span>' :
                          '<span class="badge badge-draft">Draft</span>'}
                    </td>
                    <td>
                        <button class="btn btn-xs btn-action ${onHold ? 'btn-release' : 'btn-hold'}" data-order="${order.name}">
                            ${onHold ? 'Release' : 'Hold'}
                        </button>
                    </td>
                </tr>
                <tr class="order-details-row" data-order="${order.name}" style="display:none;">
                    <td colspan="10">
                        <div class="order-details-container">Loading items...</div>
                    </td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </div>

            <style>
                .enhanced-ui .ui-box {
                    background: #ffffff;
                    border-radius: 12px;
                    padding: 18px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                    margin-top: 20px;
                }

                .enhanced-table thead th {
                    background: #f5f7ff;
                    color: #334;
                    border-bottom: 2px solid #d0d7ff;
                }

                .enhanced-table tbody tr:hover {
                    background: #f0f4ff !important;
                }

                .badge {
                    padding: 4px 8px;
                    border-radius: 8px;
                    font-size: 11px;
                    font-weight: 600;
                    display: inline-block;
                }

                .badge-region { background: #e6f7ff; color: #0366d6; }
                .badge-total { background: #fff4e6; color: #b36b00; }
                .badge-modified { background: #fff3cd; color: #8a6d3b; }
                .badge-hold { background: #f8d7da; color: #842029; }
                .badge-draft { background: #e2e3e5; color: #41464b; }

                .row-modified { background: #fff8e6 !important; }
                .row-hold { background: #fdecea !important; }

                .order-link { font-weight: bold; color: #0057b7; }
                .order-link:hover { text-decoration: underline; }

                .toggle-details { cursor: pointer; font-size: 16px; }

                .btn-action {
                    border-radius: 6px;
                    font-size: 11px;
                    padding: 5px 8px;
                }
                .btn-hold { background: #ffcc80; }
                .btn-release { background: #b2fab4; }

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

        // Select all checkbox
        this.container.find('.select-all-checkbox').off('change').on('change', function() {
            const checked = $(this).is(':checked');
            self.container.find('.order-checkbox:not(:disabled)').each(function() {
                $(this).prop('checked', checked);
                const order_name = $(this).data('order');
                if (checked) {
                    self.selected_orders.add(order_name);
                } else {
                    self.selected_orders.delete(order_name);
                }
            });
            self.render_orders();
        });

        // Individual order checkbox
        this.container.find('.order-checkbox').off('change').on('change', function() {
            const order_name = $(this).data('order');
            if ($(this).is(':checked')) {
                self.selected_orders.add(order_name);
            } else {
                self.selected_orders.delete(order_name);
            }
            self.render_orders();
        });

        // Hold/Unhold button
        this.container.find('.btn-toggle-hold').off('click').on('click', function() {
            const order_name = $(this).data('order');
            const order = self.orders.find(o => o.name === order_name);
            const currentHoldStatus = order.custom_on_hold === 1;
            
            self.toggle_hold_status(order_name, !currentHoldStatus);
        });
    }

    toggle_hold_status(order_name, hold_status) {
        frappe.call({
            method: 'frappe.client.set_value',
            args: {
                doctype: 'Sales Order',
                name: order_name,
                fieldname: 'custom_on_hold',
                value: hold_status ? 1 : 0
            },
            callback: (r) => {
                if (r.message) {
                    frappe.show_alert({
                        message: __(hold_status ? 'Order put on hold' : 'Hold released'),
                        indicator: hold_status ? 'orange' : 'green'
                    });
                    
                    // Update local data
                    const order = this.orders.find(o => o.name === order_name);
                    if (order) {
                        order.custom_on_hold = hold_status ? 1 : 0;
                    }
                    
                    // Remove from selected if putting on hold
                    if (hold_status) {
                        this.selected_orders.delete(order_name);
                    }
                    
                    this.render_orders();
                }
            },
            error: (r) => {
                frappe.msgprint(__('Error updating hold status'));
            }
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
        let html = '<div class="items-list">';
        
        items.forEach((item, idx) => {
            html += `
                <div class="item-row">
                    <div class="item-header">${item.item_code} - ${item.item_name || ''}</div>
                    <div class="item-details">
                        <span><strong>Qty:</strong> ${item.qty} ${item.uom || ''}</span>
                        <span><strong>Weight:</strong> 
                            <input type="number" 
                                   class="form-control weight-input" 
                                   data-order="${order_name}" 
                                   data-idx="${item.idx}"
                                   value="${item.weight_per_unit || 0}" 
                                   step="0.01" />
                            ${item.weight_uom || 'kg'}
                        </span>
                        <span><strong>Total Weight:</strong> <span class="total-weight">${(item.weight_per_unit || 0) * item.qty}</span> ${item.weight_uom || 'kg'}</span>
                        <button class="btn btn-sm btn-primary btn-confirm-weight" 
                                data-order="${order_name}" 
                                data-idx="${item.idx}">
                            Confirm Weight
                        </button>
                    </div>
                </div>
            `;
        });
        
        html += '</div>';
        $container.html(html);
        this.attach_item_events();
    }

    attach_item_events() {
        const self = this;
        
        this.container.find('.weight-input').off('input').on('input', function() {
            const $input = $(this);
            const $row = $input.closest('.item-row');
            const qty = parseFloat($row.find('.item-details span:first').text().match(/[\d.]+/)[0]);
            const weight = parseFloat($input.val()) || 0;
            $row.find('.total-weight').text((weight * qty).toFixed(2));
        });

        this.container.find('.btn-confirm-weight').off('click').on('click', function() {
            const $btn = $(this);
            const order_name = $btn.data('order');
            const idx = $btn.data('idx');
            const new_weight = parseFloat($btn.closest('.item-row').find('.weight-input').val());
            
            self.update_item_weight(order_name, idx, new_weight, $btn);
        });
    }

    update_item_weight(order_name, idx, new_weight, $btn) {
        frappe.call({
            method: 'frappe.client.get',
            args: {
                doctype: 'Sales Order',
                name: order_name
            },
            callback: (r) => {
                if (r.message && r.message.items) {
                    const item = r.message.items.find(i => i.idx === idx);
                    if (item && item.name) {
                        frappe.call({
                            method: 'frappe.client.set_value',
                            args: {
                                doctype: 'Sales Order Item',
                                name: item.name,
                                fieldname: 'weight_per_unit',
                                value: new_weight
                            },
                            callback: (r) => {
                                if (r.message) {
                                    frappe.show_alert({
                                        message: __('Weight updated successfully'),
                                        indicator: 'green'
                                    });
                                    
                                    this.modified_orders.add(order_name);
                                    $btn.removeClass('btn-primary').addClass('btn-success').text('✓ Saved');
                                    
                                    $(`.order-row[data-order="${order_name}"]`).addClass('modified')
                                        .find('td:nth-child(9)').html('<span class="text-warning">Modified</span>');
                                    
                                    setTimeout(() => {
                                        $btn.removeClass('btn-success').addClass('btn-primary').text('Confirm Weight');
                                    }, 2000);
                                }
                            }
                        });
                    }
                }
            }
        });
    }

    submit_selected_orders() {
        const selected_list = Array.from(this.selected_orders);
        
        if (selected_list.length === 0) {
            frappe.msgprint(__('No orders selected'));
            return;
        }

        frappe.confirm(
            __('Submit {0} selected order(s) to Pending Finance Approval?', [selected_list.length]),
            () => {
                this.process_submissions(selected_list);
            }
        );
    }

    process_submissions(order_list) {
        let processed = 0;
        let errors = [];

        const process_next = () => {
            if (processed >= order_list.length) {
                if (errors.length > 0) {
                    frappe.msgprint({
                        title: __('Submission Complete with Errors'),
                        message: __('Successfully moved {0} orders. {1} failed:<br>{2}', 
                            [order_list.length - errors.length, errors.length, errors.join('<br>')]),
                        indicator: 'orange'
                    });
                } else {
                    frappe.msgprint({
                        title: __('Success'),
                        message: __('All {0} orders sent to Pending Finance Approval', [order_list.length]),
                        indicator: 'green'
                    });
                }
                this.selected_orders.clear();
                this.modified_orders.clear();
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
                    value: 'Pending Finance Approval'
                },
                callback: (r) => {
                    if (r.message) {
                        frappe.show_alert({
                            message: __('Sent {0} to Finance', [order_name]),
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
            message: __('Sending orders to Finance for Approval...'),
            indicator: 'blue'
        });

        process_next();
    }
}