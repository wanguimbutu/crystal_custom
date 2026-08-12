// Copyright (c) 2026, Crystal Adhesives Ltd
// For license information, please see license.txt

frappe.ui.form.on("Customer Request", {
	refresh(frm) {
		if (frm.doc.customer) {
			frm.add_custom_button(__("View Customer"), () => {
				frappe.set_route("Form", "Customer", frm.doc.customer);
			});
			frm.set_intro(
				__("Customer {0} was created from this request.", [frm.doc.customer]),
				"green"
			);
		} else if (frm.doc.docstatus === 0) {
			frm.set_intro(
				__("This is a request only. The Customer record is created when Accounts approves it."),
				"blue"
			);
		}

		frm.set_query("default_price_list", () => ({
			filters: { selling: 1, enabled: 1 },
		}));

		frm.set_query("payment_terms", () => ({
			filters: { disabled: 0 },
		}));
	},

    onload(frm) {
		if (frm.is_new() && !frm.doc.company) {
			frm.set_value("company", frappe.defaults.get_user_default("Company"));
		}
	},

	customer_name(frm) {
		if (!frm.doc.customer_name || frm.doc.docstatus !== 0) return;

		frappe.db
			.get_value("Customer", { customer_name: frm.doc.customer_name }, "name")
			.then((r) => {
				if (r && r.message && r.message.name) {
					frappe.show_alert(
						{
							message: __("Customer {0} already exists.", [r.message.name]),
							indicator: "orange",
						},
						7
					);
				}
			});
	},

	tax_id(frm) {
		if (!frm.doc.tax_id || frm.doc.docstatus !== 0) return;

		frappe.db.get_value("Customer", { tax_id: frm.doc.tax_id }, "name").then((r) => {
			if (r && r.message && r.message.name) {
				frappe.msgprint({
					title: __("Duplicate Tax ID"),
					message: __("Tax ID {0} already belongs to Customer {1}.", [
						frm.doc.tax_id,
						r.message.name,
					]),
					indicator: "red",
				});
			}
		});
	},
});