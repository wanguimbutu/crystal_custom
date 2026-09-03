# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import flt
from frappe.model.document import Document


class ItemIssue(Document):
	def validate(self):
		if not self.qty or self.qty <= 0:
			frappe.throw(_("Quantity must be greater than zero."))

	def before_submit(self):
		# Only check balance when issuing — receipts always increase balance
		if (self.entry_type or 'Issue') == 'Issue':
			balance = _get_balance(self.item)
			if balance < flt(self.qty):
				frappe.throw(
					_("Insufficient stock for {0}. Available: {1} {2}, Requested: {3} {2}").format(
						self.item_name or self.item,
						frappe.format_value(balance, {"fieldtype": "Float"}),
						self.uom or '',
						frappe.format_value(flt(self.qty), {"fieldtype": "Float"}),
					)
				)


def _get_balance(item_code, exclude_name=None):
	"""Return current balance (receipts - issues) for a non-stock item."""
	rows = frappe.db.sql("""
		SELECT
			IFNULL(entry_type, 'Issue') AS entry_type,
			SUM(qty) AS total_qty
		FROM `tabItem Issue`
		WHERE item = %(item)s
		  AND docstatus = 1
		  AND (%(exclude)s IS NULL OR name != %(exclude)s)
		GROUP BY IFNULL(entry_type, 'Issue')
	""", {'item': item_code, 'exclude': exclude_name}, as_dict=1)

	receipts = sum(r.total_qty for r in rows if r.entry_type == 'Receipt')
	issues   = sum(r.total_qty for r in rows if r.entry_type == 'Issue')
	return flt(receipts) - flt(issues)


@frappe.whitelist()
def get_item_balance(item_code):
	return _get_balance(item_code)
