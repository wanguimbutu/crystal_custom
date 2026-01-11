# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt
# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors and contributors
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
	def __init__(self, filters=None):
		# Parse range filters BEFORE calling parent __init__
		if filters and filters.get("range"):
			ranges = filters.get("range").replace(",", " ").split()
			if len(ranges) >= 1:
				filters["range1"] = ranges[0]
			if len(ranges) >= 2:
				filters["range2"] = ranges[1]
			if len(ranges) >= 3:
				filters["range3"] = ranges[2]
			if len(ranges) >= 4:
				filters["range4"] = ranges[3]
		
		# Now call parent __init__
		super().__init__(filters)
	
	def run(self, args):
		self.account_type = args.get("account_type")
		self.party_type = get_party_types_from_account_type(self.account_type)
		self.party_naming_by = frappe.db.get_value(args.get("naming_by")[0], None, args.get("naming_by")[1])
		self.get_columns()
		self.get_data(args)
		return self.columns, self.data

	def get_columns(self):
		# Call parent's get_columns first
		super().get_columns()
		
		# Now add our PDC columns after Outstanding Amount
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
	
	def get_data(self, args):
		# Call parent's get_data first
		super().get_data(args)
		
		# Get PDC amounts
		pdc_amounts = get_party_pdc_amounts(self.filters.company)
		
		# Add PDC and Net Outstanding to each row
		for row in self.data:
			if isinstance(row, dict):
				row["pdc"] = pdc_amounts.get(row.get("party"), 0.0)
				row["net_outstanding"] = flt(row.get("outstanding", 0.0)) - flt(row["pdc"])


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