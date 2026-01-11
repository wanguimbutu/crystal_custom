# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import cint, flt

from erpnext.accounts.report.accounts_receivable.accounts_receivable import ReceivablePayableReport
from erpnext.accounts.utils import get_currency_precision


def execute(filters=None):
	filters = frappe._dict(filters or {})
	_set_ageing_ranges(filters)

	args = {
		"account_type": "Receivable",
		"naming_by": ["Selling Settings", "cust_master_name"],
	}

	return CustomAgingWithPDC(filters).run(args)


def _set_ageing_ranges(filters):
	"""Convert custom 'range' input ('30, 60, 90, 120') to range1..range4 expected by ERPNext."""
	# If already provided (e.g. you updated JS to send range1..range4), don't override
	if filters.get("range1"):
		return

	raw = filters.get("range") or "30, 60, 90, 120"

	if isinstance(raw, str):
		parts = [p.strip() for p in raw.replace(",", " ").split() if p.strip()]
	else:
		parts = [str(x).strip() for x in (raw or []) if str(x).strip()]

	defaults = ["30", "60", "90", "120"]
	while len(parts) < 4:
		parts.append(defaults[len(parts)])

	filters["range1"] = cint(parts[0])
	filters["range2"] = cint(parts[1])
	filters["range3"] = cint(parts[2])
	filters["range4"] = cint(parts[3])


class CustomAgingWithPDC(ReceivablePayableReport):
	def run(self, args):
		# Let ERPNext build everything (columns/data/possibly chart/message)
		result = super().run(args)

		# Parent may return:
		# - (columns, data)
		# - (columns, data, chart/message/extra)
		columns = result[0]
		data = result[1]
		extra = result[2] if len(result) > 2 else None

		# Insert our columns after Outstanding
		outstanding_idx = None
		for i, col in enumerate(columns):
			# columns are dicts
			if (col or {}).get("fieldname") == "outstanding":
				outstanding_idx = i
				break

		if outstanding_idx is not None:
			pdc_col = {
				"label": _("PDC (Post-Dated Checks)"),
				"fieldname": "pdc",
				"fieldtype": "Currency",
				"options": "currency",
				"width": 120,
			}
			net_outstanding_col = {
				"label": _("Net Outstanding"),
				"fieldname": "net_outstanding",
				"fieldtype": "Currency",
				"options": "currency",
				"width": 120,
			}

			# Prevent duplicate insert if report reruns without full reload
			fieldnames = [(c or {}).get("fieldname") for c in columns]
			if "pdc" not in fieldnames:
				columns.insert(outstanding_idx + 1, pdc_col)
			# recompute in case list changed
			fieldnames = [(c or {}).get("fieldname") for c in columns]
			if "net_outstanding" not in fieldnames:
				columns.insert(outstanding_idx + 2, net_outstanding_col)

		# Compute PDC amounts once
		pdc_amounts = get_party_pdc_amounts(self.filters.company)
		precision = get_currency_precision() or 2

		# Add PDC and Net Outstanding to each row
		for row in data or []:
			# rows are usually frappe._dict, but handle plain dict too
			party = row.get("party") if hasattr(row, "get") else None
			pdc = flt(pdc_amounts.get(party, 0.0), precision)
			outstanding = flt(row.get("outstanding", 0.0), precision)

			row["pdc"] = pdc
			row["net_outstanding"] = flt(outstanding - pdc, precision)

		# Return same shape as parent returned
		if extra is not None:
			return columns, data, extra
		return columns, data


def get_party_pdc_amounts(company):
	"""
	Fetch all draft Payment Entry records of type 'Receive'
	and sum them by party (Customer).
	"""
	pdc_data = frappe.db.sql(
		"""
		SELECT
			party,
			SUM(paid_amount) as pdc_amount
		FROM
			`tabPayment Entry`
		WHERE
			docstatus = 0
			AND payment_type = 'Receive'
			AND company = %s
			AND party_type = 'Customer'
		GROUP BY
			party
		""",
		(company,),
		as_dict=1,
	)

	return {row.party: flt(row.pdc_amount) for row in (pdc_data or [])}
