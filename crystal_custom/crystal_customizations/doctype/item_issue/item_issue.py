# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class ItemIssue(Document):
	def validate(self):
		if not self.qty or self.qty <= 0:
			frappe.throw(_("Quantity must be greater than zero."))
