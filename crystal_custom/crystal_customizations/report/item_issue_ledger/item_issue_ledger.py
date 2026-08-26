# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import flt


def execute(filters=None):
	filters = filters or {}
	columns = get_columns()
	data = get_data(filters)
	return columns, data


def get_columns():
	return [
		{"label": _("Issue No"), "fieldname": "name", "fieldtype": "Link", "options": "Item Issue", "width": 110},
		{"label": _("Date"), "fieldname": "issue_date", "fieldtype": "Date", "width": 95},
		{"label": _("Item"), "fieldname": "item", "fieldtype": "Link", "options": "Item", "width": 140},
		{"label": _("Item Name"), "fieldname": "item_name", "fieldtype": "Data", "width": 160},
		{"label": _("Qty"), "fieldname": "qty", "fieldtype": "Float", "width": 90},
		{"label": _("UOM"), "fieldname": "uom", "fieldtype": "Link", "options": "UOM", "width": 80},
		{"label": _("Running Total"), "fieldname": "running_total", "fieldtype": "Float", "width": 120},
		{"label": _("Issued To"), "fieldname": "issued_to", "fieldtype": "Data", "width": 140},
		{"label": _("Remarks"), "fieldname": "remarks", "fieldtype": "Data", "width": 200},
	]


def get_data(filters):
	conditions = ["ii.docstatus = 1"]
	params = {}

	if filters.get("from_date"):
		conditions.append("ii.issue_date >= %(from_date)s")
		params["from_date"] = filters["from_date"]
	if filters.get("to_date"):
		conditions.append("ii.issue_date <= %(to_date)s")
		params["to_date"] = filters["to_date"]
	if filters.get("item"):
		conditions.append("ii.item = %(item)s")
		params["item"] = filters["item"]
	if filters.get("issued_to"):
		conditions.append("ii.issued_to LIKE %(issued_to)s")
		params["issued_to"] = f"%{filters['issued_to']}%"

	where_clause = " AND ".join(conditions)

	rows = frappe.db.sql(f"""
		SELECT
			ii.name, ii.item, ii.item_name, ii.qty, ii.uom,
			ii.issue_date, ii.issued_to, ii.remarks
		FROM `tabItem Issue` ii
		WHERE {where_clause}
		ORDER BY ii.item_name ASC, ii.issue_date ASC, ii.creation ASC
	""", params, as_dict=1)

	running_totals = {}
	for row in rows:
		running_totals[row.item] = running_totals.get(row.item, 0) + flt(row.qty)
		row["running_total"] = running_totals[row.item]

	return rows
