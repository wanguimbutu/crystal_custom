const _ful_state = { page: 1, page_size: 50, data: [] };

frappe.pages['item-order-fulfillme'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Item Order Fulfillment',
		single_column: true
	});

	const today = frappe.datetime.get_today();

	page.add_field({
		label: 'From Date', fieldtype: 'Date', fieldname: 'from_date',
		default: frappe.datetime.add_days(today, -30),
		change: () => { _ful_state.page = 1; load_fulfillment_data(page); }
	});
	page.add_field({
		label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
		default: today,
		change: () => { _ful_state.page = 1; load_fulfillment_data(page); }
	});

	page.add_button('Refresh Analysis', function() {
		_ful_state.page = 1;
		load_fulfillment_data(page);
	}, 'primary');

	page.add_button('Create Material Request', function() {
		create_material_request(page);
	}, 'success');

	load_fulfillment_data(page);
}


function load_fulfillment_data(page) {
    page.main.html('<div class="text-center" style="padding: 50px;"><i class="fa fa-spinner fa-spin fa-3x"></i><p>Loading analysis...</p></div>');

    const from_date = page.fields_dict.from_date ? page.fields_dict.from_date.get_value() : null;
    const to_date   = page.fields_dict.to_date   ? page.fields_dict.to_date.get_value()   : null;

    frappe.call({
        method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_sales_order_fulfillment',
        args: { from_date, to_date },
        callback: function(r) {
            if (r.message) {
                _ful_state.data = r.message;
                _ful_state.page = 1;
                render_fulfillment_table(page);
            }
        }
    });
}

function render_fulfillment_table(page) {
    const data = _ful_state.data;
    const ps   = _ful_state.page_size;
    const cur  = _ful_state.page;
    const total = data.length;
    const total_pages = Math.ceil(total / ps) || 1;
    const page_data = data.slice((cur - 1) * ps, cur * ps);
    const start = (cur - 1) * ps + 1;
    const end   = Math.min(cur * ps, total);

    const pg_bar = total > ps ? `
        <div style="display:flex;align-items:center;justify-content:center;gap:14px;padding:12px;border-top:1px solid #e2e8f0;background:#f8fafc;">
            <button class="btn btn-xs btn-default" id="ful-pg-prev" ${cur <= 1 ? 'disabled' : ''}>&lsaquo; Prev</button>
            <span style="font-size:13px;color:#64748b;">Showing ${start}–${end} of ${total} &nbsp;·&nbsp; Page ${cur} of ${total_pages}</span>
            <button class="btn btn-xs btn-default" id="ful-pg-next" ${cur >= total_pages ? 'disabled' : ''}>Next &rsaquo;</button>
        </div>` : '';

    let html = `
        <div style="padding: 20px;">
            <table class="table table-bordered" style="width: 100%;">
                <thead>
                    <tr style="background-color: #1e293b; color: #fff;">
                        <th>Item Code</th>
                        <th>Item Name</th>
                        <th style="text-align:right;">Required Qty</th>
                        <th style="text-align:right;">Available Qty</th>
                        <th style="text-align:right;">Shortage</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
    `;

    page_data.forEach(function(row) {
        let shortage = row.required_qty - row.available_qty;
        let status_class = shortage > 0 ? 'danger' : 'success';
        let status_text  = shortage > 0 ? 'Insufficient' : 'Adequate';

        html += `
            <tr>
                <td>${row.item_code}</td>
                <td>${row.item_name}</td>
                <td style="text-align:right;">${row.required_qty.toFixed(2)}</td>
                <td style="text-align:right;">${row.available_qty.toFixed(2)}</td>
                <td style="text-align:right;color:${shortage > 0 ? '#dc2626' : '#059669'};font-weight:bold;">
                    ${shortage > 0 ? shortage.toFixed(2) : '0.00'}
                </td>
                <td>
                    <span class="label label-${status_class}">${status_text}</span>
                </td>
            </tr>
        `;
    });

    html += `</tbody></table>${pg_bar}</div>`;
    page.main.html(html);

    if (total > ps) {
        $('#ful-pg-prev').on('click', function() {
            if (_ful_state.page > 1) { _ful_state.page--; render_fulfillment_table(page); }
        });
        $('#ful-pg-next').on('click', function() {
            if (_ful_state.page < total_pages) { _ful_state.page++; render_fulfillment_table(page); }
        });
    }
}

function create_material_request(page) {
    const from_date = page.fields_dict.from_date ? page.fields_dict.from_date.get_value() : null;
    const to_date   = page.fields_dict.to_date   ? page.fields_dict.to_date.get_value()   : null;

    frappe.confirm(
        'This will create a draft Material Request for all items with shortages in the selected date range. Continue?',
        function() {
            frappe.call({
                method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.create_material_request_from_shortage',
                args: { from_date, to_date },
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
                        _ful_state.page = 1;
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
