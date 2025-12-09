frappe.pages['sales-order-truck-as'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Truck Assignment',
		single_column: true
	});

	new TruckAssignmentManager(page);
}

class TruckAssignmentManager {
    constructor(page) {
        this.page = page;
        this.orders = [];
        this.trucks = {};
        this.available_trucks = [];
        this.selected_orders = new Set();
        this.setup_page();
        this.load_trucks_from_orders();
    }

    setup_page() {
        const today = frappe.datetime.get_today();
        const two_days_ago = frappe.datetime.add_days(today, -2);
        const tomorrow = frappe.datetime.add_days(today, 1);

        this.page.add_field({
            label: 'From Date',
            fieldtype: 'Date',
            fieldname: 'from_date',
            default: two_days_ago,
            change: () => this.load_data()
        });

        this.page.add_field({
            label: 'To Date',
            fieldtype: 'Date',
            fieldname: 'to_date',
            default: tomorrow,
            change: () => this.load_data()
        });

        this.page.add_field({
            label: 'Delivery Region',
            fieldtype: 'Link',
            fieldname: 'delivery_region',
            options: 'Delivery Region',
            change: () => this.load_data()
        });

        this.page.set_primary_action('Add New Truck', () => {
            this.add_new_truck();
        }, 'octicon octicon-plus');

        this.page.add_button('Submit Selected Orders', () => {
            this.submit_selected_orders();
        }, 'octicon octicon-check');

        this.page.add_button('Refresh', () => {
            this.load_data();
        }, 'octicon octicon-sync');

        this.page.add_button('Back to Order Manager', () => {
            frappe.set_route('sales-order-manager');
        }, 'octicon octicon-arrow-left');

        this.container = $('<div class="truck-assignment-container"></div>').appendTo(this.page.main);
    }

    add_new_truck() {
        frappe.prompt([
            {
                label: 'Truck Number',
                fieldname: 'truck_number',
                fieldtype: 'Data',
                reqd: 1
            },
            {
                label: 'Driver Name',
                fieldname: 'driver_name',
                fieldtype: 'Data'
            },
            {
                label: 'Capacity (kg)',
                fieldname: 'capacity_kg',
                fieldtype: 'Float',
                default: 5000
            }
        ],
        (values) => {
            if (this.available_trucks.find(t => t.truck_number === values.truck_number)) {
                frappe.msgprint(__('Truck {0} already exists', [values.truck_number]));
                return;
            }
            
            this.available_trucks.push(values);
            frappe.show_alert({
                message: __('Truck {0} added', [values.truck_number]),
                indicator: 'green'
            });
            this.render_view();
        },
        __('Add New Truck'),
        __('Add Truck')
        );
    }

    load_trucks_from_orders() {
        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Sales Order',
                fields: ['custom_truck_number'],
                filters: {
                    docstatus: ['in', [0, 1]],
                    custom_truck_number: ['!=', '']
                },
                limit_page_length: 500
            },
            callback: (r) => {
                if (r.message) {
                    const unique_trucks = [...new Set(r.message.map(o => o.custom_truck_number).filter(t => t))];
                    
                    unique_trucks.forEach(truck_num => {
                        if (!this.available_trucks.find(t => t.truck_number === truck_num)) {
                            this.available_trucks.push({
                                truck_number: truck_num,
                                driver_name: '',
                                capacity_kg: 5000
                            });
                        }
                    });
                }
                this.load_data();
            }
        });
    }

    load_data() {
        const region_filter = this.page.fields_dict.delivery_region.get_value();
        const from_date = this.page.fields_dict.from_date.get_value();
        const to_date = this.page.fields_dict.to_date.get_value();
        
        let filters = {
            docstatus: ['in', [0, 1]], 
            workflow_state: ['in', ['Pending Finance Approval', 'Pending Customer Order Reconfirmation', 'Order Confirmed']],
            custom_on_hold: ['!=', 1],
            custom_truck_closed: ['!=', 1] 
        };
        
        // Add date range filter
        if (from_date && to_date) {
            filters.transaction_date = ['between', [from_date, to_date]];
        } else if (from_date) {
            filters.transaction_date = ['>=', from_date];
        } else if (to_date) {
            filters.transaction_date = ['<=', to_date];
        }
        
        if (region_filter) {
            filters.custom_delivery_region = region_filter;
        }

        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Sales Order',
                fields: ['name', 'customer', 'customer_name', 'transaction_date', 
                         'grand_total', 'custom_delivery_region', 'owner', 'custom_truck_number',
                         'total_net_weight', 'custom_call_not_picked', 'custom_call_notes', 
                         'workflow_state', 'docstatus'],
                filters: filters,
                limit_page_length: 500
            },
            callback: (r) => {
                if (r.message) {
                    this.orders = r.message;
                    
                    this.trucks = {};
                    this.orders.forEach(order => {
                        if (order.custom_truck_number) {
                            if (!this.trucks[order.custom_truck_number]) {
                                this.trucks[order.custom_truck_number] = [];
                            }
                            this.trucks[order.custom_truck_number].push(order.name);
                        }
                    });
                    
                    this.render_view();
                } else {
                    this.container.html(`
                        <div class="alert alert-info" style="margin-top: 20px;">
                            No orders awaiting truck assignment
                        </div>
                    `);
                }
            }
        });
    }

    render_view() {
        if (this.orders.length === 0 && this.available_trucks.length === 0) {
            this.container.html(`
                <div class="alert alert-info" style="margin-top: 20px;">
                    No orders awaiting truck assignment. Click "Add New Truck" to begin.
                </div>
            `);
            return;
        }

        const unassigned = this.orders.filter(o => !o.custom_truck_number);
        const assigned = this.orders.filter(o => o.custom_truck_number);
        const warning_count = this.orders.filter(o => o.custom_call_not_picked === 1).length;
        const in_confirmation = this.orders.filter(o => o.workflow_state === 'Pending Customer Order Reconfirmation').length;
        const confirmed_count = this.orders.filter(o => o.workflow_state === 'Order Confirmed').length;
        const can_submit = this.orders.filter(o => o.docstatus === 0 && o.workflow_state === 'Pending Customer Order Reconfirmation').length;
        
        const from_date = this.page.fields_dict.from_date.get_value();
        const to_date = this.page.fields_dict.to_date.get_value();
        const date_range_text = from_date && to_date ? 
            `${frappe.datetime.str_to_user(from_date)} to ${frappe.datetime.str_to_user(to_date)}` : 
            'All dates';
        
        let html = `
            <div class="assignment-view">
                <div class="date-range-info" style="background: #e3f2fd; padding: 10px 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #2196F3;">
                    <strong> Showing orders from:</strong> ${date_range_text}
                    <span style="margin-left: 20px; color: #666;">
                        Default: 2 days before to 1 day after current date
                    </span>
                </div>
                <div class="summary-section">
                    <div class="summary-cards">
                        <div class="summary-card">
                            <h4>Total Orders</h4>
                            <div class="summary-value">${this.orders.length}</div>
                        </div>
                        <div class="summary-card">
                            <h4>Total Value</h4>
                            <div class="summary-value">${format_currency(this.calculate_total_value())}</div>
                        </div>
                        <div class="summary-card">
                            <h4>Total Weight</h4>
                            <div class="summary-value">${this.calculate_total_weight().toFixed(2)} kg</div>
                        </div>
                        <div class="summary-card">
                            <h4>Trucks Available</h4>
                            <div class="summary-value">${this.available_trucks.length}</div>
                        </div>
                        ${can_submit > 0 ? `
                            <div class="summary-card submit-card">
                                <h4> Can Submit</h4>
                                <div class="summary-value">${can_submit}</div>
                                <small style="color: #0369a1;">${this.selected_orders.size} selected</small>
                            </div>
                        ` : ''}
                        ${confirmed_count > 0 ? `
                            <div class="summary-card success-card">
                                <h4>✓ Confirmed & Ready</h4>
                                <div class="summary-value">${confirmed_count}</div>
                                <small style="color: #065f46;">Ready for delivery</small>
                            </div>
                        ` : ''}
                        ${in_confirmation > 0 ? `
                            <div class="summary-card info-card">
                                <h4>📞 In Customer Confirmation</h4>
                                <div class="summary-value">${in_confirmation}</div>
                                <small style="color: #0369a1;">Being called for confirmation</small>
                            </div>
                        ` : ''}
                        ${warning_count > 0 ? `
                            <div class="summary-card warning-card">
                                <h4> Customer Contact Issues</h4>
                                <div class="summary-value">${warning_count}</div>
                                <small style="color: #856404;">Calls not picked - driver alert</small>
                            </div>
                        ` : ''}
                    </div>
                </div>

                ${this.available_trucks.length > 0 ? `
                    <div class="trucks-section">
                        <h3>Assigned Trucks (${Object.keys(this.trucks).length} of ${this.available_trucks.length})</h3>
                        ${this.render_trucks()}
                    </div>
                ` : ''}

                <div class="orders-section">
                    <h3>Orders Awaiting Assignment (${unassigned.length})</h3>
                    ${this.render_orders_table(unassigned)}
                </div>
            </div>

            <style>
                .assignment-view { margin-top: 20px; }
                .summary-section { margin-bottom: 30px; }
                .summary-cards { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
                    gap: 15px; 
                }
                .summary-card {
                    background: white;
                    border: 1px solid #d1d8dd;
                    border-radius: 8px;
                    padding: 20px;
                    text-align: center;
                }
                .summary-card.warning-card {
                    background: linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%);
                    border: 2px solid #ffc107;
                }
                .summary-card.info-card {
                    background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
                    border: 2px solid #3b82f6;
                }
                .summary-card.success-card {
                    background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%);
                    border: 2px solid #10b981;
                }
                .summary-card.submit-card {
                    background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
                    border: 2px solid #3b82f6;
                }
                .summary-card h4 {
                    margin: 0 0 10px 0;
                    color: #6c757d;
                    font-size: 14px;
                    font-weight: 500;
                }
                .summary-value {
                    font-size: 24px;
                    font-weight: 600;
                    color: #2c3e50;
                }
                .orders-section, .trucks-section { margin-bottom: 30px; }
                
                .trucks-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                    gap: 20px;
                    margin-top: 15px;
                }
                .truck-card {
                    background: white;
                    border: 2px solid #4CAF50;
                    border-radius: 8px;
                    padding: 15px;
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                }
                .truck-card.empty-truck {
                    border: 2px dashed #ccc;
                    background: #f8f9fa;
                }
                .truck-card.has-warnings {
                    border-color: #ffc107;
                    background: linear-gradient(to bottom, #fffbf0 0%, #ffffff 100%);
                }
                .truck-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 10px;
                    padding-bottom: 10px;
                    border-bottom: 2px solid #e9ecef;
                }
                .truck-title {
                    font-size: 16px;
                    font-weight: 600;
                    color: #2c3e50;
                }
                .truck-actions {
                    display: flex;
                    gap: 5px;
                }
                .truck-stats {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 10px;
                    flex-wrap: wrap;
                }
                .truck-stat {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                    min-width: 80px;
                    background: #f8f9fa;
                    padding: 8px;
                    border-radius: 4px;
                }
                .truck-stat-label {
                    color: #6c757d;
                    font-size: 11px;
                    text-transform: uppercase;
                }
                .truck-stat-value {
                    font-weight: 600;
                    color: #2c3e50;
                    font-size: 14px;
                }
                .truck-orders-list {
                    flex-grow: 1;
                    overflow-y: auto;
                    max-height: 300px;
                }
                .truck-order-item {
                    padding: 8px;
                    margin-bottom: 6px;
                    background: #f8f9fa;
                    border-radius: 4px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    font-size: 12px;
                }
                .truck-order-info {
                    flex-grow: 1;
                }
                .truck-order-name {
                    font-weight: 600;
                    color: #2c3e50;
                }
                .truck-order-details {
                    color: #6c757d;
                    font-size: 11px;
                }
                .truck-select {
                    width: 100%;
                    max-width: 200px;
                }
                .empty-truck-message {
                    text-align: center;
                    color: #6c757d;
                    padding: 20px;
                    font-style: italic;
                }
                
                /* Warning styles */
                .warning-row {
                    background-color: #fff9e6 !important;
                }
                .confirmation-row {
                    background-color: #eff6ff !important;
                }
                .confirmed-row {
                    background-color: #d1fae5 !important;
                }
                .warning-icon {
                    font-size: 16px;
                    margin-right: 5px;
                    color: #ffc107;
                }
                .info-icon {
                    font-size: 16px;
                    margin-right: 5px;
                }
                .success-icon {
                    font-size: 16px;
                    margin-right: 5px;
                    color: #10b981;
                    font-weight: bold;
                }
                .warning-badge {
                    font-size: 14px;
                    margin-right: 4px;
                    background: #ffc107;
                    color: #000;
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-weight: 600;
                }
                .warning-note {
                    color: #856404;
                    font-size: 10px;
                    font-style: italic;
                    display: block;
                    margin-top: 2px;
                }
                .truck-order-item.has-warning {
                    border-left: 3px solid #ffc107;
                    background: #fff9e6;
                }
                .truck-order-item.has-info {
                    border-left: 3px solid #3b82f6;
                    background: #eff6ff;
                }
                .truck-order-item.has-success {
                    border-left: 3px solid #10b981;
                    background: #d1fae5;
                }
                .info-badge {
                    font-size: 14px;
                    margin-right: 4px;
                    background: #3b82f6;
                    color: #fff;
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-weight: 600;
                }
                .success-badge {
                    font-size: 14px;
                    margin-right: 4px;
                    background: #10b981;
                    color: #fff;
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-weight: 600;
                }
                .warning-alert {
                    background: #fff3cd;
                    border: 1px solid #ffc107;
                    border-radius: 6px;
                    padding: 8px 12px;
                    margin-bottom: 10px;
                    font-size: 12px;
                    color: #856404;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
            </style>
        `;

        this.container.html(html);
        this.attach_events();
    }

    render_orders_table(orders) {
        if (orders.length === 0) {
            return '<p class="text-muted">All orders have been assigned to trucks</p>';
        }

        let html = `
            <div style="margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                <label style="margin: 0;">
                    <input type="checkbox" class="select-all-orders" style="margin-right: 5px;">
                    Select All Unsubmitted
                </label>
                <span class="text-muted">${this.selected_orders.size} selected</span>
            </div>
            <table class="table table-bordered">
                <thead>
                    <tr>
                        <th width="3%"></th>
                        <th>Sales Order</th>
                        <th>Customer</th>
                        <th>Region</th>
                        <th>Weight (kg)</th>
                        <th>Value</th>
                        <th width="200">Truck Assignment</th>
                    </tr>
                </thead>
                <tbody>
        `;

        orders.forEach(order => {
            const hasWarning = order.custom_call_not_picked === 1;
            const inConfirmation = order.workflow_state === 'Pending Customer Order Reconfirmation';
            const isConfirmed = order.workflow_state === 'Order Confirmed';
            const canSelect = order.docstatus === 0 && inConfirmation;
            const isSelected = this.selected_orders.has(order.name);
            
            html += `
                <tr ${hasWarning ? 'class="warning-row"' : inConfirmation ? 'class="confirmation-row"' : isConfirmed ? 'class="confirmed-row"' : ''}>
                    <td>
                        ${canSelect ? 
                            `<input type="checkbox" class="order-checkbox" data-order="${order.name}" ${isSelected ? 'checked' : ''}>` :
                            ''}
                    </td>
                    <td>
                        ${hasWarning ? '<span class="warning-icon" title="Customer call not picked">⚠️</span>' : ''}
                        ${inConfirmation && !hasWarning ? '<span class="info-icon" title="In customer confirmation">📞</span>' : ''}
                        ${isConfirmed && !hasWarning ? '<span class="success-icon" title="Confirmed & ready">✓</span>' : ''}
                        <a href="/app/sales-order/${order.name}" target="_blank">${order.name}</a>
                    </td>
                    <td>
                        ${order.customer_name || order.customer}
                        ${hasWarning && order.custom_call_notes ? 
                            `<br><small class="text-muted" style="font-style: italic; color: #856404;">📝 ${order.custom_call_notes}</small>` : ''}
                    </td>
                    <td>${order.custom_delivery_region || ''}</td>
                    <td>${(order.total_net_weight || 0).toFixed(2)}</td>
                    <td>${format_currency(order.grand_total)}</td>
                    <td>
                        <select class="form-control truck-select" data-order="${order.name}" ${order.docstatus === 1 ? 'disabled' : ''}>
                            <option value="">Select Truck...</option>
                            ${this.available_trucks.map(truck => 
                                `<option value="${truck.truck_number}" 
                                    ${order.custom_truck_number === truck.truck_number ? 'selected' : ''}>
                                    ${truck.truck_number}${truck.driver_name ? ' - ' + truck.driver_name : ''}
                                </option>`
                            ).join('')}
                        </select>
                        ${order.docstatus === 1 ? '<br><small class="text-muted">Submitted - locked</small>' : ''}
                    </td>
                </tr>
            `;
        });

        html += `
                </tbody>
            </table>
        `;

        return html;
    }

    render_trucks() {
        let html = '<div class="trucks-grid">';
        
        this.available_trucks.forEach(truck => {
            const truck_number = truck.truck_number;
            const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
            const total_weight = truck_orders.reduce((sum, o) => sum + (o.total_net_weight || 0), 0);
            const total_value = truck_orders.reduce((sum, o) => sum + (o.grand_total || 0), 0);
            const warning_orders = truck_orders.filter(o => o.custom_call_not_picked === 1);
            
            const capacity = truck.capacity_kg || 0;
            const capacity_pct = capacity > 0 ? ((total_weight / capacity) * 100).toFixed(1) : 0;
            const is_empty = truck_orders.length === 0;
            const has_warnings = warning_orders.length > 0;
            
            html += `
                <div class="truck-card ${is_empty ? 'empty-truck' : ''} ${has_warnings ? 'has-warnings' : ''}">
                    <div class="truck-header">
                        <div class="truck-title">🚚 ${truck_number}</div>
                        <div class="truck-actions">
                            <button class="btn btn-xs btn-success btn-download-manifest" 
                                    data-truck="${truck_number}"
                                    title="Download Truck Manifest">
                                📄
                            </button>
                            <button class="btn btn-xs btn-warning btn-edit-truck" 
                                    data-truck="${truck_number}"
                                    title="Edit Truck Details">
                                ✏️
                            </button>
                            ${!is_empty ? `
                                <button class="btn btn-xs btn-info btn-reassign-truck" 
                                        data-truck="${truck_number}"
                                        title="Reassign Orders">
                                    🔄
                                </button>
                            ` : ''}
                            <button class="btn btn-xs btn-danger btn-delete-truck" 
                                    data-truck="${truck_number}"
                                    title="${is_empty ? 'Remove Truck' : 'Unassign All Orders'}">
                                ${is_empty ? '✕' : '🗑️'}
                            </button>
                            ${!is_empty ? `
                                <button class="btn btn-xs btn-primary btn-close-truck" 
                                        data-truck="${truck_number}"
                                        title="Close & Archive Truck">
                                    🔒 Close
                                </button>
                            ` : ''}
                        </div>
                    </div>
                    
                    ${truck.driver_name ? 
                        `<div style="font-size: 12px; color: #6c757d; margin-bottom: 10px;">
                            👤 ${truck.driver_name}
                        </div>` : ''}
                    
                    ${has_warnings ? `
                        <div class="warning-alert">
                            <span>⚠️</span>
                            <span><strong>${warning_orders.length}</strong> customer(s) didn't answer confirmation call - driver should contact on arrival</span>
                        </div>
                    ` : ''}
                    
                    ${is_empty ? `
                        <div class="empty-truck-message">
                            No orders assigned yet
                        </div>
                    ` : `
                        <div class="truck-stats">
                            <div class="truck-stat">
                                <span class="truck-stat-label">Orders</span>
                                <span class="truck-stat-value">${truck_orders.length}</span>
                            </div>
                            <div class="truck-stat">
                                <span class="truck-stat-label">Weight</span>
                                <span class="truck-stat-value">${total_weight.toFixed(0)} kg</span>
                            </div>
                            <div class="truck-stat">
                                <span class="truck-stat-label">Value</span>
                                <span class="truck-stat-value">${format_currency(total_value, null, 0)}</span>
                            </div>
                        </div>
                        
                        ${capacity > 0 ? `
                            <div style="margin-bottom: 10px;">
                                <div style="font-size: 11px; color: #6c757d; margin-bottom: 3px;">
                                    Capacity: ${capacity_pct}% (${total_weight.toFixed(0)} / ${capacity} kg)
                                </div>
                                <div style="background: #e9ecef; border-radius: 4px; height: 8px; overflow: hidden;">
                                    <div style="background: ${capacity_pct > 100 ? '#dc3545' : capacity_pct > 90 ? '#ffc107' : '#28a745'}; 
                                                width: ${Math.min(capacity_pct, 100)}%; height: 100%;"></div>
                                </div>
                            </div>
                        ` : ''}
                        
                        <div class="truck-orders-list">
                    `}
            `;
            
            if (!is_empty) {
                truck_orders.forEach(order => {
                    const hasWarning = order.custom_call_not_picked === 1;
                    const inConfirmation = order.workflow_state === 'Pending Customer Order Reconfirmation';
                    const isConfirmed = order.workflow_state === 'Order Confirmed';
                    
                    html += `
                        <div class="truck-order-item ${hasWarning ? 'has-warning' : inConfirmation ? 'has-info' : isConfirmed ? 'has-success' : ''}">
                            <div class="truck-order-info">
                                <div class="truck-order-name">
                                    ${hasWarning ? '<span class="warning-badge">⚠️</span>' : ''}
                                    ${inConfirmation && !hasWarning ? '<span class="info-badge">📞</span>' : ''}
                                    ${isConfirmed && !hasWarning ? '<span class="success-badge">✓</span>' : ''}
                                    <a href="/app/sales-order/${order.name}" target="_blank">${order.name}</a>
                                </div>
                                <div class="truck-order-details">
                                    ${order.customer_name || order.customer} • ${(order.total_net_weight || 0).toFixed(0)} kg
                                    ${hasWarning && order.custom_call_notes ? 
                                        `<span class="warning-note">⚠️ ${order.custom_call_notes}</span>` : ''}
                                </div>
                            </div>
                            <button class="btn btn-xs btn-danger btn-unassign" 
                                    data-order="${order.name}"
                                    title="Remove from truck"
                                    ${order.docstatus === 1 ? 'disabled' : ''}>
                                ✕
                            </button>
                        </div>
                    `;
                });
                
                html += `</div>`;
            }
            
            html += `
                </div>
            `;
        });
        
        html += '</div>';
        return html;
    }

    attach_events() {
        const self = this;
        
        // Select all checkbox
        this.container.find('.select-all-orders').off('change').on('change', function() {
            const checked = $(this).is(':checked');
            self.container.find('.order-checkbox').each(function() {
                $(this).prop('checked', checked);
                const order_name = $(this).data('order');
                if (checked) {
                    self.selected_orders.add(order_name);
                } else {
                    self.selected_orders.delete(order_name);
                }
            });
            self.render_view();
        });

        // Individual order checkbox
        this.container.find('.order-checkbox').off('change').on('change', function() {
            const order_name = $(this).data('order');
            if ($(this).is(':checked')) {
                self.selected_orders.add(order_name);
            } else {
                self.selected_orders.delete(order_name);
            }
            self.render_view();
        });
        
        this.container.find('.truck-select').off('change').on('change', function() {
            const order_name = $(this).data('order');
            const truck_number = $(this).val();
            
            if (truck_number) {
                self.assign_truck(order_name, truck_number);
            } else {
                self.unassign_truck(order_name);
            }
        });

        this.container.find('.btn-unassign').off('click').on('click', function() {
            const order_name = $(this).data('order');
            self.unassign_truck(order_name);
        });

        this.container.find('.btn-edit-truck').off('click').on('click', function() {
            const truck_number = $(this).data('truck');
            self.edit_truck_details(truck_number);
        });

        this.container.find('.btn-reassign-truck').off('click').on('click', function() {
            const old_truck = $(this).data('truck');
            self.reassign_truck_orders(old_truck);
        });

        this.container.find('.btn-delete-truck').off('click').on('click', function() {
            const truck_number = $(this).data('truck');
            self.delete_truck(truck_number);
        });

        this.container.find('.btn-close-truck').off('click').on('click', function() {
            const truck_number = $(this).data('truck');
            self.close_truck(truck_number);
        });

        this.container.find('.btn-download-manifest').off('click').on('click', function() {
            const truck_number = $(this).data('truck');
            self.download_manifest(truck_number);
        });
    }

    assign_truck(order_name, truck_number) {
        frappe.call({
            method: 'frappe.client.set_value',
            args: {
                doctype: 'Sales Order',
                name: order_name,
                fieldname: 'custom_truck_number',
                value: truck_number
            },
            callback: (r) => {
                if (r.message) {
                    frappe.show_alert({
                        message: __('Truck assigned successfully'),
                        indicator: 'green'
                    });
                    this.load_data();
                }
            }
        });
    }

    unassign_truck(order_name) {
        frappe.call({
            method: 'frappe.client.set_value',
            args: {
                doctype: 'Sales Order',
                name: order_name,
                fieldname: 'custom_truck_number',
                value: ''
            },
            callback: (r) => {
                if (r.message) {
                    frappe.show_alert({
                        message: __('Truck unassigned'),
                        indicator: 'orange'
                    });
                    this.load_data();
                }
            }
        });
    }

    edit_truck_details(truck_number) {
        const truck = this.available_trucks.find(t => t.truck_number === truck_number);
        
        frappe.prompt([
            {
                label: 'Truck Number',
                fieldname: 'truck_number',
                fieldtype: 'Data',
                default: truck.truck_number,
                reqd: 1
            },
            {
                label: 'Driver Name',
                fieldname: 'driver_name',
                fieldtype: 'Data',
                default: truck.driver_name
            },
            {
                label: 'Capacity (kg)',
                fieldname: 'capacity_kg',
                fieldtype: 'Float',
                default: truck.capacity_kg || 5000
            }
        ],
        (values) => {
            const old_truck_number = truck.truck_number;
            const new_truck_number = values.truck_number;
            
            truck.truck_number = values.truck_number;
            truck.driver_name = values.driver_name;
            truck.capacity_kg = values.capacity_kg;
            
            if (old_truck_number !== new_truck_number) {
                const orders_to_update = this.orders.filter(o => o.custom_truck_number === old_truck_number);
                if (orders_to_update.length > 0) {
                    this.bulk_update_truck_number(orders_to_update, new_truck_number);
                } else {
                    this.render_view();
                }
            } else {
                this.render_view();
            }
            
            frappe.show_alert({
                message: __('Truck details updated'),
                indicator: 'green'
            });
        },
        __('Edit Truck Details'),
        __('Update')
        );
    }

    reassign_truck_orders(old_truck_number) {
        const truck_orders = this.orders.filter(o => o.custom_truck_number === old_truck_number);
        
        frappe.prompt([
            {
                label: 'New Truck',
                fieldname: 'new_truck',
                fieldtype: 'Select',
                options: this.available_trucks
                    .filter(t => t.truck_number !== old_truck_number)
                    .map(t => t.truck_number + (t.driver_name ? ' - ' + t.driver_name : ''))
                    .join('\n'),
                reqd: 1
            }
        ],
        (values) => {
            const new_truck_number = values.new_truck.split(' - ')[0];
            this.bulk_update_truck_number(truck_orders, new_truck_number);
        },
        __('Reassign Orders from {0}', [old_truck_number]),
        __('Reassign')
        );
    }

    delete_truck(truck_number) {
        const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
        const is_empty = truck_orders.length === 0;
        
        if (is_empty) {
            this.available_trucks = this.available_trucks.filter(t => t.truck_number !== truck_number);
            frappe.show_alert({
                message: __('Truck removed'),
                indicator: 'green'
            });
            this.render_view();
        } else {
            frappe.confirm(
                __('Unassign all {0} orders from {1}? They will return to the unassigned list.', 
                    [truck_orders.length, truck_number]),
                () => {
                    this.unassign_multiple_orders(truck_orders);
                }
            );
        }
    }

    bulk_update_truck_number(orders, new_truck_number) {
        let processed = 0;
        
        const process_next = () => {
            if (processed >= orders.length) {
                frappe.show_alert({
                    message: __('All orders reassigned to {0}', [new_truck_number]),
                    indicator: 'green'
                });
                this.load_data();
                return;
            }

            frappe.call({
                method: 'frappe.client.set_value',
                args: {
                    doctype: 'Sales Order',
                    name: orders[processed].name,
                    fieldname: 'custom_truck_number',
                    value: new_truck_number
                },
                callback: () => {
                    processed++;
                    process_next();
                }
            });
        };

        process_next();
    }

    unassign_multiple_orders(orders) {
        let processed = 0;
        
        const process_next = () => {
            if (processed >= orders.length) {
                frappe.show_alert({
                    message: __('All orders unassigned'),
                    indicator: 'green'
                });
                this.load_data();
                return;
            }

            frappe.call({
                method: 'frappe.client.set_value',
                args: {
                    doctype: 'Sales Order',
                    name: orders[processed].name,
                    fieldname: 'custom_truck_number',
                    value: ''
                },
                callback: () => {
                    processed++;
                    process_next();
                }
            });
        };

        process_next();
    }

    calculate_total_value() {
        return this.orders.reduce((sum, order) => sum + (order.grand_total || 0), 0);
    }

    calculate_total_weight() {
        return this.orders.reduce((sum, order) => sum + (order.total_net_weight || 0), 0);
    }

    submit_selected_orders() {
        const selected_list = Array.from(this.selected_orders);
        
        if (selected_list.length === 0) {
            frappe.msgprint(__('No orders selected'));
            return;
        }

        // Get order details
        const selected_order_objs = this.orders.filter(o => selected_list.includes(o.name));
        
        frappe.confirm(
            __('Submit {0} selected order(s) to Order Confirmed state?<br><br>Orders will be locked after submission.', 
                [selected_list.length]),
            () => {
                this.process_submissions(selected_order_objs);
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
                        message: __('Successfully submitted {0} orders. {1} failed:<br>{2}', 
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
                this.selected_orders.clear();
                this.load_data();
                return;
            }

            const order_name = order_list[processed].name;
            
            frappe.call({
                method: 'frappe.client.get',
                args: {
                    doctype: 'Sales Order',
                    name: order_name
                },
                callback: (r) => {
                    if (r.message) {
                        const doc = r.message;
                        doc.workflow_state = 'Order Confirmed';
                        
                        frappe.call({
                            method: 'frappe.client.save',
                            args: {
                                doc: doc
                            },
                            callback: (r2) => {
                                if (r2.message) {
                                    frappe.call({
                                        method: 'frappe.client.submit',
                                        args: {
                                            doc: r2.message
                                        },
                                        callback: (r3) => {
                                            if (r3.message) {
                                                frappe.show_alert({
                                                    message: __('Confirmed & Submitted {0}', [order_name]),
                                                    indicator: 'green'
                                                });
                                                processed++;
                                            } else {
                                                errors.push(order_name);
                                                processed++;
                                            }
                                            process_next();
                                        },
                                        error: () => {
                                            errors.push(order_name + ' (submit failed)');
                                            processed++;
                                            process_next();
                                        }
                                    });
                                } else {
                                    errors.push(order_name + ' (save failed)');
                                    processed++;
                                    process_next();
                                }
                            },
                            error: () => {
                                errors.push(order_name + ' (save failed)');
                                processed++;
                                process_next();
                            }
                        });
                    } else {
                        errors.push(order_name + ' (get failed)');
                        processed++;
                        process_next();
                    }
                },
                error: () => {
                    errors.push(order_name + ' (get failed)');
                    processed++;
                    process_next();
                }
            });
        };

        frappe.show_alert({
            message: __('Submitting orders...'),
            indicator: 'blue'
        });

        process_next();
    }

    close_truck(truck_number) {
        const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
        const truck_info = this.available_trucks.find(t => t.truck_number === truck_number);
        
        if (truck_orders.length === 0) {
            frappe.msgprint(__('Cannot close an empty truck'));
            return;
        }

        // Check if all orders are submitted
        const unsubmitted = truck_orders.filter(o => o.docstatus === 0);
        
        if (unsubmitted.length > 0) {
            frappe.confirm(
                __('Truck {0} has {1} unsubmitted order(s). Close anyway?<br><br>Unsubmitted orders will remain in the system but truck will be archived.', 
                    [truck_number, unsubmitted.length]),
                () => {
                    this.finalize_truck_closure(truck_number, truck_orders, truck_info);
                }
            );
        } else {
            frappe.confirm(
                __('Close truck {0} with {1} orders?<br><br>The truck and its manifest will be archived and removed from this view.', 
                    [truck_number, truck_orders.length]),
                () => {
                    this.finalize_truck_closure(truck_number, truck_orders, truck_info);
                }
            );
        }
    }

    finalize_truck_closure(truck_number, truck_orders, truck_info) {
        // First, download the manifest
        this.download_manifest(truck_number);
        
        // Mark all orders as "truck closed"
        let processed = 0;
        const update_next = () => {
            if (processed >= truck_orders.length) {
                // Remove truck from available trucks
                this.available_trucks = this.available_trucks.filter(t => t.truck_number !== truck_number);
                
                // Remove orders from display by filtering them out
                this.orders = this.orders.filter(o => o.custom_truck_number !== truck_number);
                
                frappe.show_alert({
                    message: __('Truck {0} closed and archived', [truck_number]),
                    indicator: 'green'
                });
                
                this.render_view();
                return;
            }

            const order = truck_orders[processed];
            
            frappe.call({
                method: 'frappe.client.set_value',
                args: {
                    doctype: 'Sales Order',
                    name: order.name,
                    fieldname: 'custom_truck_closed',
                    value: 1
                },
                callback: () => {
                    processed++;
                    update_next();
                },
                error: () => {
                    processed++;
                    update_next();
                }
            });
        };

        frappe.show_alert({
            message: __('Closing truck {0}...', [truck_number]),
            indicator: 'blue'
        });

        update_next();
    }

    download_manifest(truck_number) {
        const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
        const truck_info = this.available_trucks.find(t => t.truck_number === truck_number);
        
        if (truck_orders.length === 0) {
            frappe.msgprint(__('No orders in this truck'));
            return;
        }

        const total_weight = truck_orders.reduce((sum, o) => sum + (o.total_net_weight || 0), 0);
        const total_value = truck_orders.reduce((sum, o) => sum + (o.grand_total || 0), 0);
        
        // Create HTML table for Excel
        let html_content = `
            <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
            <head>
                <meta charset="utf-8">
                <!--[if gte mso 9]>
                <xml>
                    <x:ExcelWorkbook>
                        <x:ExcelWorksheets>
                            <x:ExcelWorksheet>
                                <x:Name>Truck Manifest</x:Name>
                                <x:WorksheetOptions>
                                    <x:DisplayGridlines/>
                                </x:WorksheetOptions>
                            </x:ExcelWorksheet>
                        </x:ExcelWorksheets>
                    </x:ExcelWorkbook>
                </xml>
                <![endif]-->
                <style>
                    table { border-collapse: collapse; width: 100%; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #4CAF50; color: white; font-weight: bold; }
                    .header-section { margin-bottom: 20px; }
                    .header-row td { border: none; padding: 4px 8px; }
                    .header-label { font-weight: bold; width: 150px; }
                    .warning-row { background-color: #fff3cd; }
                    .title { font-size: 18px; font-weight: bold; margin-bottom: 10px; }
                </style>
            </head>
            <body>
                <div class="title">TRUCK DELIVERY MANIFEST</div>
                <table class="header-section">
                    <tr class="header-row">
                        <td class="header-label">Truck Number:</td>
                        <td>${truck_number}</td>
                    </tr>`;
        
        if (truck_info && truck_info.driver_name) {
            html_content += `
                    <tr class="header-row">
                        <td class="header-label">Driver:</td>
                        <td>${truck_info.driver_name}</td>
                    </tr>`;
        }
        
        html_content += `
                    <tr class="header-row">
                        <td class="header-label">Date:</td>
                        <td>${frappe.datetime.now_date()}</td>
                    </tr>
                    <tr class="header-row">
                        <td class="header-label">Time:</td>
                        <td>${frappe.datetime.now_time()}</td>
                    </tr>
                    <tr class="header-row">
                        <td class="header-label">Total Orders:</td>
                        <td>${truck_orders.length}</td>
                    </tr>
                    <tr class="header-row">
                        <td class="header-label">Total Weight:</td>
                        <td>${total_weight.toFixed(2)} kg</td>
                    </tr>
                    <tr class="header-row">
                        <td class="header-label">Total Value:</td>
                        <td>${format_currency(total_value)}</td>
                    </tr>
                </table>
                
                <br>
                
                <table>
                    <thead>
                        <tr>
                            <th>Order Number</th>
                            <th>Customer</th>
                            <th>Region</th>
                            <th>Weight (kg)</th>
                            <th>Value</th>
                            <th>Status</th>
                            <th>Contact Issue</th>
                            <th>Notes</th>
                        </tr>
                    </thead>
                    <tbody>`;
        
        // Order details
        truck_orders.forEach(order => {
            const status = order.docstatus === 1 ? 'Submitted' : 
                          order.workflow_state === 'Order Confirmed' ? 'Confirmed' :
                          order.workflow_state === 'Pending Customer Order Reconfirmation' ? 'Pending Confirmation' :
                          'Draft';
            
            const contact_issue = order.custom_call_not_picked === 1 ? 'YES ⚠️' : 'NO';
            const notes = order.custom_call_notes || '';
            const row_class = order.custom_call_not_picked === 1 ? 'warning-row' : '';
            
            html_content += `
                        <tr class="${row_class}">
                            <td>${order.name}</td>
                            <td>${order.customer_name || order.customer}</td>
                            <td>${order.custom_delivery_region || ''}</td>
                            <td style="text-align: right;">${(order.total_net_weight || 0).toFixed(2)}</td>
                            <td style="text-align: right;">${order.grand_total.toFixed(2)}</td>
                            <td>${status}</td>
                            <td style="text-align: center;">${contact_issue}</td>
                            <td>${notes}</td>
                        </tr>`;
        });
        
        html_content += `
                    </tbody>
                </table>
            </body>
            </html>`;
        
        // Create and download Excel file
        const blob = new Blob([html_content], { 
            type: 'application/vnd.ms-excel;charset=utf-8;' 
        });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        
        link.setAttribute('href', url);
        link.setAttribute('download', `Truck_${truck_number}_${frappe.datetime.now_date()}.xls`);
        link.style.visibility = 'hidden';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        frappe.show_alert({
            message: __('Excel manifest downloaded for truck {0}', [truck_number]),
            indicator: 'green'
        });
    }
}