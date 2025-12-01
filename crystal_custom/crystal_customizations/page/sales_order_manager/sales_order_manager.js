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
        this.setup_page();
        this.load_data();
    }

    setup_page() {
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
            change: () => this.apply_filters()
        });

        this.page.set_primary_action('Submit All to Finance', () => {
            this.submit_all_orders();
        }, 'octicon octicon-check');

        this.page.add_button('Refresh', () => {
            this.load_data();
        }, 'octicon octicon-sync');

        this.container = $('<div class="draft-orders-container"></div>').appendTo(this.page.main);
    }

    load_data() {
        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Sales Order',
                fields: ['name', 'customer', 'customer_name', 'transaction_date', 'grand_total', 'custom_delivery_region', 'owner', 'workflow_state'],
                filters: {
                    docstatus: 0 
                },
                limit_page_length: 500
            },
            callback: (r) => {
                if (r.message) {
                    console.log('Fetched orders:', r.message);
                    // Show orders in "Proceed To Order" state (before finance approval)
                    this.orders = r.message.filter(order => {
                        console.log(`Order ${order.name}: workflow_state = "${order.workflow_state}"`);
                        return !order.workflow_state || 
                               order.workflow_state === '' || 
                               order.workflow_state === null ||
                               order.workflow_state === 'Proceed To Order';
                    });
                    console.log('Filtered orders (Proceed To Order state):', this.orders);
                    this.render_orders();
                } else {
                    console.log('No orders returned');
                    frappe.msgprint(__('No draft sales orders found'));
                }
            },
            error: (r) => {
                console.error('Error fetching orders:', r);
                frappe.msgprint(__('Error fetching sales orders. Check console for details.'));
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
            if (this.filters.delivery_region && order.custom_delivery_region !== this.filters.delivery_region) {
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
                        'No draft sales orders without workflow state found.'}
                </div>
            `);
            return;
        }
        
        let html = `
            <div class="orders-table">
                <div style="margin-bottom: 10px;">
                    <strong>Showing ${filtered_orders.length} of ${this.orders.length} orders</strong>
                </div>
                <table class="table table-bordered">
                    <thead>
                        <tr>
                            <th width="5%"></th>
                            <th width="15%">Sales Order</th>
                            <th width="20%">Customer</th>
                            <th width="12%">Date</th>
                            <th width="15%">Region</th>
                            <th width="15%">Sales Person</th>
                            <th width="10%">Total</th>
                            <th width="8%">Status</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        filtered_orders.forEach(order => {
            const modified = this.modified_orders.has(order.name);
            html += `
                <tr class="order-row ${modified ? 'modified' : ''}" data-order="${order.name}">
                    <td>
                        <span class="toggle-details" style="cursor:pointer; font-size: 16px;">▶</span>
                    </td>
                    <td><a href="/app/sales-order/${order.name}" target="_blank">${order.name}</a></td>
                    <td>${order.customer_name || order.customer}</td>
                    <td>${frappe.datetime.str_to_user(order.transaction_date)}</td>
                    <td>${order.custom_delivery_region || ''}</td>
                    <td>${order.owner}</td>
                    <td>${format_currency(order.grand_total)}</td>
                    <td>${modified ? '<span class="text-warning">Modified</span>' : '<span class="text-muted">Draft</span>'}</td>
                </tr>
                <tr class="order-details-row" data-order="${order.name}" style="display:none;">
                    <td colspan="8">
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
            <style>
                .orders-table { margin-top: 20px; }
                .order-row.modified { background-color: #fff3cd; }
                .item-row { margin-bottom: 10px; padding: 10px; border: 1px solid #dee2e6; border-radius: 4px; }
                .item-header { font-weight: 600; margin-bottom: 8px; }
                .item-details { display: flex; gap: 15px; align-items: center; }
                .weight-input { width: 100px; }
                .btn-confirm-weight { margin-left: 10px; }
            </style>
        `;

        this.container.html(html);
        this.attach_events();
    }

    attach_events() {
        const self = this;
        
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
        
        // Update total weight on input change
        this.container.find('.weight-input').off('input').on('input', function() {
            const $input = $(this);
            const $row = $input.closest('.item-row');
            const qty = parseFloat($row.find('.item-details span:first').text().match(/[\d.]+/)[0]);
            const weight = parseFloat($input.val()) || 0;
            $row.find('.total-weight').text((weight * qty).toFixed(2));
        });

        // Confirm weight change
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
                                        .find('td:last').html('<span class="text-warning">Modified</span>');
                                    
                                    setTimeout(() => {
                                        $btn.removeClass('btn-success').addClass('btn-primary').text('Confirm Weight');
                                    }, 2000);
                                }
                            },
                            error: (r) => {
                                frappe.msgprint(__('Error updating weight: {0}', [r.message || 'Unknown error']));
                            }
                        });
                    } else {
                        frappe.msgprint(__('Could not find item with idx {0}', [idx]));
                    }
                }
            }
        });
    }

    submit_all_orders() {
        const modified_list = Array.from(this.modified_orders);
        
        if (modified_list.length === 0) {
            frappe.msgprint(__('No orders have been modified'));
            return;
        }

        frappe.confirm(
            __('Submit {0} modified order(s) to Pending Finance Approval?', [modified_list.length]),
            () => {
                this.process_submissions(modified_list);
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
                        message: __('Successfully moved {0} orders to finance. {1} failed:<br>{2}', 
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