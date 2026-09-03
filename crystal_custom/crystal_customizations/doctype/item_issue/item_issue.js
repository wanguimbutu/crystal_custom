// Copyright (c) 2026, wangui and contributors
// For license information, please see license.txt

frappe.ui.form.on('Item Issue', {
	refresh(frm) {
		if (frm.doc.item) {
			_show_balance(frm);
		}
	},

	item(frm) {
		if (frm.doc.item) {
			_show_balance(frm);
		} else {
			frm.dashboard.clear_headline();
		}
	},

	entry_type(frm) {
		if (frm.doc.item) {
			_show_balance(frm);
		}
	},
});

function _show_balance(frm) {
	frappe.call({
		method: 'crystal_custom.crystal_customizations.doctype.item_issue.item_issue.get_item_balance',
		args: { item_code: frm.doc.item },
		callback(r) {
			const balance = r.message || 0;
			const color   = balance > 0 ? 'green' : (balance < 0 ? 'red' : 'grey');
			frm.dashboard.set_headline(
				`<span style="color:${color};font-weight:600;">
					Current Balance: ${frappe.format(balance, { fieldtype: 'Float' })}
					${frm.doc.uom || ''}
				</span>`
			);
		},
	});
}
