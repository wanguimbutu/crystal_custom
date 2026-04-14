frappe.pages['sales-stock-report'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Sales Stock Report',
		single_column: true
	});

	page.main.html(`
		<div class="sales-stock-report" style="padding: 20px;">

			<!-- Filters -->
			<div class="filter-bar" style="display:flex; gap:16px; align-items:flex-end; flex-wrap:wrap;
				background:#fff; border:1px solid #e2e6ea; border-radius:6px; padding:16px; margin-bottom:20px;">
				<div>
					<label style="display:block; font-size:11px; font-weight:600; color:#6c757d;
						text-transform:uppercase; letter-spacing:.05em; margin-bottom:5px;">From Date</label>
					<input type="date" id="ssr-from" style="height:34px; padding:0 10px; border:1px solid #ced4da;
						border-radius:4px; font-size:13px;" />
				</div>
				<div>
					<label style="display:block; font-size:11px; font-weight:600; color:#6c757d;
						text-transform:uppercase; letter-spacing:.05em; margin-bottom:5px;">To Date</label>
					<input type="date" id="ssr-to" style="height:34px; padding:0 10px; border:1px solid #ced4da;
						border-radius:4px; font-size:13px;" />
				</div>
				<div>
					<label style="display:block; font-size:11px; font-weight:600; color:#6c757d;
						text-transform:uppercase; letter-spacing:.05em; margin-bottom:5px;">Warehouse</label>
					<input type="text" id="ssr-warehouse" placeholder="All Warehouses"
						style="height:34px; padding:0 10px; border:1px solid #ced4da; border-radius:4px;
						font-size:13px; min-width:180px;" />
				</div>
				<button id="ssr-run" class="btn btn-primary btn-sm" style="height:34px; padding:0 18px;">
					Generate Report
				</button>
			</div>

			<!-- Summary cards -->
			<div id="ssr-summary" style="display:none; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:20px;">
				<div class="ssr-card" style="background:#fff; border:1px solid #e2e6ea; border-radius:6px; padding:14px 16px;">
					<div style="font-size:11px; color:#6c757d; font-weight:600; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px;">Total Items</div>
					<div id="s-total" style="font-size:24px; font-weight:600; color:#1a1a2e;">0</div>
				</div>
				<div class="ssr-card" style="background:#fff; border:1px solid #e2e6ea; border-radius:6px; padding:14px 16px;">
					<div style="font-size:11px; color:#6c757d; font-weight:600; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px;">Deficit Items</div>
					<div id="s-deficit" style="font-size:24px; font-weight:600; color:#c0392b;">0</div>
				</div>
				<div class="ssr-card" style="background:#fff; border:1px solid #e2e6ea; border-radius:6px; padding:14px 16px;">
					<div style="font-size:11px; color:#6c757d; font-weight:600; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px;">Excess Items</div>
					<div id="s-excess" style="font-size:24px; font-weight:600; color:#1e8449;">0</div>
				</div>
				<div class="ssr-card" style="background:#fff; border:1px solid #e2e6ea; border-radius:6px; padding:14px 16px;">
					<div style="font-size:11px; color:#6c757d; font-weight:600; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px;">MRs Created</div>
					<div id="s-mr" style="font-size:24px; font-weight:600; color:#1a1a2e;">0</div>
				</div>
			</div>

			<!-- Table -->
			<div id="ssr-table-wrap" style="display:none; background:#fff; border:1px solid #e2e6ea; border-radius:6px; overflow:hidden;">
				<div style="display:flex; justify-content:space-between; align-items:center;
					padding:12px 16px; border-bottom:1px solid #e2e6ea;">
					<span id="ssr-table-title" style="font-size:14px; font-weight:600; color:#1a1a2e;">Report Results</span>
					<button id="ssr-create-all" class="btn btn-default btn-xs"
						style="font-size:12px; color:#1565c0; border-color:#1565c0;">
						Create MR for All Deficits
					</button>
				</div>
				<div style="overflow-x:auto;">
					<table class="table table-bordered" style="margin:0; font-size:13px;">
						<thead style="background:#f8f9fa;">
							<tr>
								<th style="width:11%; white-space:nowrap;">Item Code</th>
								<th style="width:20%;">Description</th>
								<th style="width:9%;">UOM</th>
								<th style="width:10%; text-align:right;">Ordered Qty</th>
								<th style="width:10%; text-align:right;">In Stock</th>
								<th style="width:12%; text-align:right;">Deficit / Excess</th>
								<th style="width:9%;">Status</th>
								<th style="width:11%;">Warehouse</th>
								<th style="width:10%;">Action</th>
							</tr>
						</thead>
						<tbody id="ssr-tbody"></tbody>
					</table>
				</div>
			</div>

			<div id="ssr-empty" style="display:none; text-align:center; padding:3rem 1rem;
				color:#6c757d; font-size:14px;">No sales order items found for the selected date range.</div>

			<div id="ssr-loading" style="display:none; text-align:center; padding:3rem 1rem; color:#6c757d;">
				<div class="spinner-border spinner-border-sm" role="status"></div>
				&nbsp; Loading report data...
			</div>
		</div>
	`);

	// Set default dates
	var today = frappe.datetime.get_today();
	var firstOfMonth = today.slice(0,7) + '-01';
	document.getElementById('ssr-from').value = firstOfMonth;
	document.getElementById('ssr-to').value = today;

	// Warehouse autocomplete
	var warehouseInput = document.getElementById('ssr-warehouse');
	frappe.call({
		method: 'frappe.client.get_list',
		args: { doctype: 'Warehouse', fields: ['name'], limit_page_length: 100 },
		callback: function(r) {
			if (r.message) {
				var datalist = document.createElement('datalist');
				datalist.id = 'ssr-warehouse-list';
				r.message.forEach(function(w) {
					var opt = document.createElement('option');
					opt.value = w.name;
					datalist.appendChild(opt);
				});
				document.body.appendChild(datalist);
				warehouseInput.setAttribute('list', 'ssr-warehouse-list');
			}
		}
	});

	var reportData = [];
	var mrCreated = {};

	function runReport() {
		var fromDate = document.getElementById('ssr-from').value;
		var toDate = document.getElementById('ssr-to').value;
		var warehouse = document.getElementById('ssr-warehouse').value;

		if (!fromDate || !toDate) {
			frappe.msgprint('Please select both From and To dates.');
			return;
		}

		document.getElementById('ssr-loading').style.display = 'block';
		document.getElementById('ssr-table-wrap').style.display = 'none';
		document.getElementById('ssr-summary').style.display = 'none';
		document.getElementById('ssr-empty').style.display = 'none';

		frappe.call({
			method: 'crystal_custom.crystal_customizations.api.sales_stock_report.get_report_data',
			args: { from_date: fromDate, to_date: toDate, warehouse: warehouse || null },
			callback: function(r) {
				document.getElementById('ssr-loading').style.display = 'none';
				if (r.message && r.message.length > 0) {
					reportData = r.message;
					renderTable(reportData);
					renderSummary(reportData);
					document.getElementById('ssr-summary').style.display = 'grid';
					document.getElementById('ssr-table-wrap').style.display = 'block';
					var from = frappe.datetime.str_to_user(fromDate);
					var to = frappe.datetime.str_to_user(toDate);
					document.getElementById('ssr-table-title').textContent =
						'Results: ' + from + ' \u2013 ' + to;
				} else {
					document.getElementById('ssr-empty').style.display = 'block';
				}
			}
		});
	}

	function renderTable(data) {
		var tbody = document.getElementById('ssr-tbody');
		tbody.innerHTML = '';
		data.forEach(function(row) {
			var diff = row.actual_qty - row.ordered_qty;
			var diffDisplay = diff === 0 ? '\u2014' :
				(diff > 0 ? '+' + frappe.utils.formatNumber(diff, null, 2) :
				frappe.utils.formatNumber(diff, null, 2));
			var diffStyle = diff < 0 ? 'color:#c0392b; font-weight:600;' :
				(diff > 0 ? 'color:#1e8449; font-weight:600;' : '');
			var badge = diff < 0
				? '<span class="badge" style="background:#fdecea; color:#c0392b; font-size:11px;">Deficit</span>'
				: (diff > 0
					? '<span class="badge" style="background:#e8f5e9; color:#1e8449; font-size:11px;">Excess</span>'
					: '<span class="badge" style="background:#f5f5f5; color:#555; font-size:11px;">Balanced</span>');

			var alreadyCreated = mrCreated[row.item_code + '|' + row.warehouse];
			var actionHtml = diff < 0
				? (alreadyCreated
					? '<button class="btn btn-xs" disabled style="background:#e8f5e9;color:#1e8449;border-color:#a5d6a7;">MR Created</button>'
					: '<button class="btn btn-xs btn-default ssr-create-btn" style="font-size:12px;" '
						+ 'data-item="' + row.item_code + '" data-item-name="' + (row.item_name||row.item_code) + '" '
						+ 'data-warehouse="' + row.warehouse + '" data-uom="' + row.stock_uom + '" '
						+ 'data-qty="' + Math.abs(diff) + '">Create MR</button>')
				: '<span style="color:#aaa; font-size:12px;">\u2014</span>';

			var tr = document.createElement('tr');
			tr.innerHTML = '<td style="font-family:monospace; font-size:12px;">' + row.item_code + '</td>'
				+ '<td>' + (row.item_name || row.item_code) + '</td>'
				+ '<td>' + (row.stock_uom || '') + '</td>'
				+ '<td style="text-align:right;">' + frappe.utils.formatNumber(row.ordered_qty, null, 2) + '</td>'
				+ '<td style="text-align:right;">' + frappe.utils.formatNumber(row.actual_qty, null, 2) + '</td>'
				+ '<td style="text-align:right; ' + diffStyle + '">' + diffDisplay + '</td>'
				+ '<td>' + badge + '</td>'
				+ '<td style="font-size:12px; color:#555;">' + (row.warehouse || '') + '</td>'
				+ '<td>' + actionHtml + '</td>';
			tbody.appendChild(tr);
		});

		// Bind Create MR buttons
		tbody.querySelectorAll('.ssr-create-btn').forEach(function(btn) {
			btn.addEventListener('click', function() {
				openMRDialog(
					this.dataset.item,
					this.dataset.itemName,
					this.dataset.warehouse,
					this.dataset.uom,
					parseFloat(this.dataset.qty)
				);
			});
		});
	}

	function renderSummary(data) {
		document.getElementById('s-total').textContent = data.length;
		document.getElementById('s-deficit').textContent =
			data.filter(function(r) { return r.actual_qty < r.ordered_qty; }).length;
		document.getElementById('s-excess').textContent =
			data.filter(function(r) { return r.actual_qty > r.ordered_qty; }).length;
		document.getElementById('s-mr').textContent = Object.keys(mrCreated).length;
	}

	function openMRDialog(itemCode, itemName, warehouse, uom, qty) {
		var d = new frappe.ui.Dialog({
			title: 'Create Material Request',
			fields: [
				{ fieldtype: 'HTML', fieldname: 'info_html',
					options: '<div style="background:#f8f9fa; border-radius:4px; padding:12px 14px; margin-bottom:10px; font-size:13px;">'
						+ '<table style="width:100%;">'
						+ '<tr><td style="color:#6c757d; padding:3px 0; width:40%;">Item</td><td><strong>' + itemCode + '</strong> &ndash; ' + itemName + '</td></tr>'
						+ '<tr><td style="color:#6c757d; padding:3px 0;">Required qty</td><td><strong>' + frappe.utils.formatNumber(qty,null,2) + ' ' + uom + '</strong></td></tr>'
						+ '<tr><td style="color:#6c757d; padding:3px 0;">Warehouse</td><td>' + warehouse + '</td></tr>'
						+ '</table></div>'
						+ '<p style="font-size:13px; color:#555; margin:0;">On confirmation, a Material Request (Purchase type) will be created and notifications sent to all '
						+ '<strong>Manufacturing Users</strong> and <strong>Manufacturing Managers</strong>.</p>'
				},
				{ fieldtype: 'Date', fieldname: 'schedule_date', label: 'Required By Date',
					reqd: 1, default: frappe.datetime.add_days(frappe.datetime.get_today(), 7) },
				{ fieldtype: 'Small Text', fieldname: 'remarks', label: 'Remarks (optional)' }
			],
			primary_action_label: 'Confirm & Notify',
			primary_action: function(values) {
				d.hide();
				frappe.call({
					method: 'crystal_custom.crystal_customizations.api.sales_stock_report.create_material_request',
					args: {
						item_code: itemCode,
						warehouse: warehouse,
						qty: qty,
						uom: uom,
						schedule_date: values.schedule_date,
						remarks: values.remarks || ''
					},
					freeze: true,
					freeze_message: 'Creating Material Request & sending notifications...',
					callback: function(r) {
						if (r.message && r.message.mr_name) {
							mrCreated[itemCode + '|' + warehouse] = r.message.mr_name;
							renderTable(reportData);
							renderSummary(reportData);
							frappe.show_alert({
								message: 'Material Request <a href="/app/material-request/'
									+ r.message.mr_name + '">' + r.message.mr_name + '</a> created. '
									+ r.message.notified + ' user(s) notified.',
								indicator: 'green'
							}, 8);
						}
					}
				});
			}
		});
		d.show();
	}

	// Create all deficits
	document.getElementById('ssr-create-all').addEventListener('click', function() {
		var deficits = reportData.filter(function(r) {
			return r.actual_qty < r.ordered_qty && !mrCreated[r.item_code + '|' + r.warehouse];
		});
		if (!deficits.length) {
			frappe.msgprint('All deficit items already have Material Requests created.');
			return;
		}
		frappe.confirm(
			'Create Material Requests for <strong>' + deficits.length + ' deficit item(s)</strong>? '
			+ 'Notifications will be sent to Manufacturing Users and Managers.',
			function() {
				var today = frappe.datetime.get_today();
				var schedDate = frappe.datetime.add_days(today, 7);
				frappe.call({
					method: 'crystal_custom.crystal_customizations.api.sales_stock_report.create_material_requests_bulk',
					args: {
						items: deficits.map(function(r) {
							return {
								item_code: r.item_code,
								warehouse: r.warehouse,
								qty: r.ordered_qty - r.actual_qty,
								uom: r.stock_uom
							};
						}),
						schedule_date: schedDate
					},
					freeze: true,
					freeze_message: 'Creating Material Requests...',
					callback: function(r) {
						if (r.message) {
							r.message.created.forEach(function(key) {
								mrCreated[key] = true;
							});
							renderTable(reportData);
							renderSummary(reportData);
							frappe.show_alert({
								message: r.message.count + ' Material Request(s) created. '
									+ r.message.notified + ' user(s) notified.',
								indicator: 'green'
							}, 8);
						}
					}
				});
			}
		);
	});

	document.getElementById('ssr-run').addEventListener('click', runReport);
};