# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt


import frappe
from frappe import _, scrub
from frappe.utils import cint, flt

from erpnext.accounts.party import get_partywise_advanced_payment_amount
from erpnext.accounts.report.accounts_receivable.accounts_receivable import ReceivablePayableReport
from erpnext.accounts.utils import get_currency_precision, get_party_types_from_account_type


def execute(filters=None):
	args = {
		"account_type": "Receivable",
		"naming_by": ["Selling Settings", "cust_master_name"],
	}

	return CustomAgingWithPDC(filters).run(args)


class CustomAgingWithPDC(ReceivablePayableReport):
	def run(self, args):
		# Call parent run method to handle all initialization
		columns, data = super().run(args)
		
		# Now add our PDC columns to the existing columns
		# Find the position after "Outstanding Amount" column
		outstanding_idx = None
		for i, col in enumerate(self.columns):
			if col.get("fieldname") == "outstanding":
				outstanding_idx = i
				break
		
		if outstanding_idx is not None:
			# Insert PDC column after Outstanding
			pdc_col = {
				"label": _("PDC (Post-Dated Checks)"),
				"fieldname": "pdc",
				"fieldtype": "Currency",
				"options": "currency",
				"width": 120
			}
			self.columns.insert(outstanding_idx + 1, pdc_col)
			
			# Insert Net Outstanding column after PDC
			net_outstanding_col = {
				"label": _("Net Outstanding"),
				"fieldname": "net_outstanding",
				"fieldtype": "Currency",
				"options": "currency",
				"width": 120
			}
			self.columns.insert(outstanding_idx + 2, net_outstanding_col)
		
		# Get PDC amounts
		pdc_amounts = get_party_pdc_amounts(self.filters.company)
		
		# Add PDC and Net Outstanding to each row
		for row in self.data:
			if isinstance(row, dict):
				row["pdc"] = pdc_amounts.get(row.get("party"), 0.0)
				row["net_outstanding"] = flt(row.get("outstanding", 0.0)) - flt(row["pdc"])
		
		return self.columns, self.data


def get_gl_balance(report_date, company):
	return frappe._dict(
		frappe.db.get_all(
			"GL Entry",
			fields=["party", "sum(debit -  credit)"],
			filters={"posting_date": ("<=", report_date), "is_cancelled": 0, "company": company},
			group_by="party",
			as_list=1,
		)
	)


def get_party_pdc_amounts(company):
	"""
	Fetch all draft Payment Entry records of type 'Receive' 
	and sum them by party (Customer)
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
		as_dict=1
	)
	
	# Convert to dictionary for easy lookup
	pdc_dict = {}
	for row in pdc_data:
		pdc_dict[row.party] = flt(row.pdc_amount)
	
	return pdc_dict