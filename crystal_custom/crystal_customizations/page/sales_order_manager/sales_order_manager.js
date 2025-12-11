frappe.pages['sales-order-manager'].on_page_load = function(wrapper) {
	console.log('=== SALES ORDER MANAGER PAGE LOADING ===');
	console.log('Wrapper:', wrapper);
	
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Sales Order Manager',
		single_column: true
	});
	
	console.log('Page created:', page);

	new DraftSalesOrdersManager(page);
}

class DraftSalesOrdersManager {
    constructor(page) {
        console.log('=== DraftSalesOrdersManager Constructor ===');
        console.log('Page object:', page);
        
        this.page = page;
        this.filters = {};
        this.orders = [];
        this.modified_orders = new Set();
        this.selected_orders = new Set();
        this.held_orders = new Set();
        
        console.log('Calling setup_page...');
        this.setup_page();
        
        console.log('Calling load_data...');
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

        this.page.set_primary_action('Submit Selected to Finance', () => {
            this.submit_selected_orders();
        }, 'octicon octicon-check');

        this.page.add_button('Refresh', () => {
            this.load_data();
        }, 'octicon octicon-sync');

        this.page.add_button('View Truck Assignment', () => {
            frappe.set_route('sales-order-truck-assignment');
        }, 'octicon octicon-package');

        this.container = $('<div class="draft-orders-container"></div>').appendTo(this.page.main);
    }

    load_data() {
        console.log('=== LOAD_DATA START ===');
        
        try {
            console.log('Making frappe.call...');
            
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
                    console.log('=== CALLBACK RECEIVED ===');
                    console.log('Response:', r);
                    
                    if (r.message) {
                        console.log('All fetched orders:', r.message);
                        console.log('Total draft orders found:', r.message.length);
                        
                        // Log workflow states
                        const workflow_states = {};
                        r.message.forEach(order => {
                            const state = order.workflow_state || 'null/empty';
                            workflow_states[state] = (workflow_states[state] || 0) + 1;
                        });
                        console.log('Workflow state distribution:', workflow_states);
                        
                        // Filter orders
                        this.orders = r.message.filter(order => {
                            const isMatch = !order.workflow_state || 
                                order.workflow_state === '' || 
                                order.workflow_state === null ||
                                order.workflow_state === 'Proceed To Order';
                            
                            if (!isMatch) {
                                console.log(`Filtered out ${order.name}: workflow_state = "${order.workflow_state}"`);
                            }
                            return isMatch;
                        });
                        
                        console.log('Filtered orders (should show):', this.orders.length);
                        console.log('Orders to display:', this.orders);
                        
                        if (this.orders.length === 0) {
                            console.warn('⚠️ No orders match the filter criteria!');
                            console.warn('Check if your workflow states match "Proceed To Order" or are empty/null');
                        }
                        
                        console.log('Calling render_orders...');
                        this.render_orders();
                    } else {
                        console.error('❌ No orders returned from server');
                        frappe.msgprint(__('No draft sales orders found'));
                    }
                },
                error: (r) => {
                    console.error('❌ Error fetching orders:', r);
                    console.error('Error details:', r);
                    frappe.msgprint(__('Error fetching sales orders. Check console for details.'));
                }
            });
            
            console.log('frappe.call initiated successfully');
        } catch (error) {
            console.error('❌ Exception in load_data:', error);
            console.error('Stack:', error.stack);
        }
        
        console.log('=== LOAD_DATA END ===');
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
                        'No draft sales orders found.'}
                </div>
            `);
            return;
        }
        
        let html = `
            <div class="orders-table">
                <div style="margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong>Showing ${filtered_orders.length} of ${this.orders.length} orders</strong>
                        <span style="margin-left: 15px; color: #666;">
                            (${this.selected_orders.size} selected)
                        </span>
                    </div>
                    <div>
                        <label style="margin-right: 15px;">
                            <input type="checkbox" class="select-all-checkbox" style="margin-right: 5px;">
                            Select All
                        </label>
                    </div>
                </div>
                <table class="table table-bordered">
                    <thead>
                        <tr>
                            <th width="3%"></th>
                            <th width="4%"></th>
                            <th width="15%">Sales Order</th>
                            <th width="18%">Customer</th>
                            <th width="10%">Date</th>
                            <th width="12%">Region</th>
                            <th width="12%">Sales Person</th>
                            <th width="10%">Total</th>
                            <th width="10%">Status</th>
                            <th width="6%">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        filtered_orders.forEach(order => {
            const modified = this.modified_orders.has(order.name);
            const selected = this.selected_orders.has(order.name);
            const onHold = order.custom_on_hold === 1;
            
            html += `
                <tr class="order-row ${modified ? 'modified' : ''} ${onHold ? 'on-hold' : ''}" data-order="${order.name}">
                    <td>
                        <input type="checkbox" 
                               class="order-checkbox" 
                               data-order="${order.name}"
                               ${selected ? 'checked' : ''}
                               ${onHold ? 'disabled' : ''}>
                    </td>
                    <td>
                        <span class="toggle-details" style="cursor:pointer; font-size: 16px;">▶</span>
                    </td>
                    <td><a href="/app/sales-order/${order.name}" target="_blank">${order.name}</a></td>
                    <td>${order.customer_name || order.customer}</td>
                    <td>${frappe.datetime.str_to_user(order.transaction_date)}</td>
                    <td>${order.custom_delivery_region || ''}</td>
                    <td>${order.owner}</td>
                    <td>${format_currency(order.grand_total)}</td>
                    <td>
                        ${onHold ? '<span class="text-danger"><strong>ON HOLD</strong></span>' :
                          modified ? '<span class="text-warning">Modified</span>' : 
                          '<span class="text-muted">Draft</span>'}
                    </td>
                    <td>
                        <button class="btn btn-xs ${onHold ? 'btn-success' : 'btn-warning'} btn-toggle-hold" 
                                data-order="${order.name}"
                                title="${onHold ? 'Release Hold' : 'Put on Hold'}">
                            ${onHold ? '▶' : '⏸'}
                        </button>
                    </td>
                </tr>
                <tr class="order-details-row" data-order="${order.name}" style="display:none;">
                    <td colspan="10">
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
                .order-row.on-hold { background-color: #f8d7da; }
                .item-row { margin-bottom: 10px; padding: 10px; border: 1px solid #dee2e6; border-radius: 4px; }
                .item-header { font-weight: 600; margin-bottom: 8px; }
                .item-details { display: flex; gap: 15px; align-items: center; }
                .weight-input { width: 100px; }
                .btn-confirm-weight { margin-left: 10px; }
                .order-checkbox { cursor: pointer; width: 16px; height: 16px; }
                .select-all-checkbox { cursor: pointer; width: 16px; height: 16px; }
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