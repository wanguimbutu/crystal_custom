# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


class CustomerRequest(Document):
	def validate(self):
		self.customer_name = (self.customer_name or "").strip()
		self.tax_id = (self.tax_id or "").strip() or None
		self.validate_duplicate_customer()
		self.validate_duplicate_request()
		self.validate_duplicate_tax_id()
		self.validate_rejection_reason()

	# ------------------------------------------------------------------
	# Validation
	# ------------------------------------------------------------------
	def validate_duplicate_customer(self):
		"""Block a request whose name collides with an existing Customer."""
		existing = frappe.db.get_value(
			"Customer", {"customer_name": self.customer_name}, "name"
		)
		if not existing:
			return

		msg = _("A Customer named {0} already exists.").format(frappe.bold(existing))
		if self.docstatus == 0:
			frappe.msgprint(msg, title=_("Possible Duplicate"), indicator="orange")
		else:
			frappe.throw(msg, title=_("Duplicate Customer"))

	def validate_duplicate_request(self):
		"""Block two open requests for the same customer name."""
		dup = frappe.db.get_value(
			"Customer Request",
			{
				"customer_name": self.customer_name,
				"name": ("!=", self.name),
				"docstatus": ("<", 2),
				"customer": ("is", "not set"),
			},
			"name",
		)
		if dup:
			frappe.throw(
				_("An open Customer Request {0} already exists for this name.").format(
					frappe.bold(dup)
				),
				title=_("Duplicate Request"),
			)

	def validate_duplicate_tax_id(self):
		if not self.tax_id:
			return

		existing = frappe.db.get_value("Customer", {"tax_id": self.tax_id}, "name")
		if existing:
			frappe.throw(
				_("Tax ID {0} is already used by Customer {1}.").format(
					frappe.bold(self.tax_id), frappe.bold(existing)
				),
				title=_("Duplicate Tax ID"),
			)

	def validate_rejection_reason(self):
		if self.get("workflow_state") == "Rejected" and not (self.rejection_reason or "").strip():
			frappe.throw(_("Please enter a Rejection Reason before rejecting this request."))

	# ------------------------------------------------------------------
	# Lifecycle
	# ------------------------------------------------------------------
	def on_submit(self):
		if self.customer:
			frappe.throw(
				_("Customer {0} has already been created from this request.").format(
					frappe.bold(self.customer)
				)
			)

		customer = self.create_customer()

		self.db_set("customer", customer.name, update_modified=False)
		self.db_set("approved_by", frappe.session.user, update_modified=False)
		self.db_set("approved_on", now_datetime(), update_modified=False)

		frappe.msgprint(
			_("Customer {0} created.").format(
				frappe.utils.get_link_to_form("Customer", customer.name)
			),
			alert=True,
			indicator="green",
		)

	def on_cancel(self):
		if self.customer:
			frappe.throw(
				_(
					"This request cannot be cancelled because Customer {0} was already created. "
					"Disable the Customer record instead."
				).format(frappe.bold(self.customer)),
				title=_("Cancellation Blocked"),
			)

	# ------------------------------------------------------------------
	# Customer creation
	# ------------------------------------------------------------------
	def create_customer(self):
		customer = frappe.new_doc("Customer")
		customer.update(
			{
				"customer_name": self.customer_name,
				"customer_type": self.customer_type,
				"customer_group": self.customer_group,
				"territory": self.territory,
				"industry": self.industry,
				"tax_id": self.tax_id,
				"tax_category": self.tax_category,
				"tax_withholding_category": self.tax_withholding_category,
				"default_currency": self.default_currency,
				"default_price_list": self.default_price_list,
				"payment_terms": self.payment_terms,
				"bypass_credit_limit_check_at_sales_order": self.bypass_credit_limit_check,
				# The fields below drive ERPNext's automatic creation of the
				# primary Address and primary Contact in Customer.on_update().
				"address_line1": self.address_line1,
				"address_line2": self.address_line2,
				"city": self.city,
				"state": self.state,
				"country": self.country,
				"pincode": self.pincode,
				"email_id": self.email_id,
				"mobile_no": self.mobile_no,
			}
		)

		if self.credit_limit:
			customer.append(
				"credit_limits",
				{"company": self.company, "credit_limit": self.credit_limit},
			)

		customer.flags.ignore_permissions = True
		customer.insert()

		return customer


def block_direct_customer_creation(doc, method=None):
	"""Hooked onto Customer.before_insert.

	Stops anyone outside the allowed roles from inserting a Customer without
	going through an approved Customer Request. Set the System Setting
	`crystal_allow_direct_customer` (or use Administrator) to bypass.
	"""
	allowed_roles = {"System Manager", "Accounts Manager"}

	if frappe.flags.in_install or frappe.flags.in_migrate or frappe.flags.in_import:
		return

	if frappe.session.user == "Administrator":
		return

	if allowed_roles & set(frappe.get_roles(frappe.session.user)):
		return

	frappe.throw(
		_(
			"Customers cannot be created directly. Please raise a "
			"<b>Customer Request</b> for approval by Accounts."
		),
		title=_("Approval Required"),
	)