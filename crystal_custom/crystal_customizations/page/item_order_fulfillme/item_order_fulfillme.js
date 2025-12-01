frappe.pages['item-order-fulfillme'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Item Order Fulfillment',
		single_column: true
	});
	page.add_button('Refresh Analysis', function() {
		load_fulfillment_data(page);

	}, 'primary');

	 page.add_button('Create Material Request', function() {
        create_material_request(page);
    }, 'success');


	load_fulfillment_data(page);
	
}


function load_fulfillment_data(page) {
    page.main.html('<div class="text-center" style="padding: 50px;"><i class="fa fa-spinner fa-spin fa-3x"></i><p>Loading analysis...</p></div>');

    frappe.call({
        method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_sales_order_fulfillment',
        callback: function(r) {
            if (r.message) {
                render_fulfillment_table(page, r.message);
            }
        }
    });
}

function render_fulfillment_table(page, data) {
    let html = `
        <div style="padding: 20px;">
            <table class="table table-bordered" style="width: 100%;">
                <thead>
                    <tr style="background-color: #f0f4f7;">
                        <th>Item Code</th>
                        <th>Item Name</th>
                        <th>Required Qty</th>
                        <th>Available Qty</th>
                        <th>Shortage</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
    `;

    data.forEach(function(row) {
        let shortage = row.required_qty - row.available_qty;
        let status_class = shortage > 0 ? 'danger' : 'success';
        let status_text = shortage > 0 ? 'Insufficient' : 'Adequate';
        let row_style = shortage > 0 ? 'background-color: #ffe6e6;' : '';

        html += `
            <tr style="${row_style}">
                <td>${row.item_code}</td>
                <td>${row.item_name}</td>
                <td>${row.required_qty.toFixed(2)}</td>
                <td>${row.available_qty.toFixed(2)}</td>
                <td style="color: ${shortage > 0 ? 'red' : 'green'}; font-weight: bold;">
                    ${shortage > 0 ? shortage.toFixed(2) : '0.00'}
                </td>
                <td>
                    <span class="label label-${status_class}">${status_text}</span>
                </td>
            </tr>
        `;
    });

    html += `
                </tbody>
            </table>
        </div>
    `;

    page.main.html(html);
}

function create_material_request(page) {
    frappe.confirm(
        'This will create a draft Material Request for all items with shortages. Continue?',
        function() {
            frappe.call({
                method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.create_material_request_from_shortage',
                freeze: true,
                freeze_message: __('Creating Material Request...'),
                callback: function(r) {
                    if (r.message) {
                        frappe.msgprint({
                            title: __('Success'),
                            message: __('Material Request {0} created successfully', 
                                ['<a href="/app/material-request/' + r.message + '">' + r.message + '</a>']),
                            indicator: 'green'
                        });
                        load_fulfillment_data(page);
                    }
                },
                error: function(r) {
                    frappe.msgprint({
                        title: __('Error'),
                        message: __('Failed to create Material Request'),
                        indicator: 'red'
                    });
                }
            });
        }
    );
}
