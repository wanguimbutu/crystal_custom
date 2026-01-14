# Copyright (c) 2025, Crystal Customizations
# License: MIT
# Outstanding Debts Report with Month-Wise Breakdown (Corrected Calculation)

import frappe
from frappe import _
from frappe.utils import flt, getdate
from collections import OrderedDict

def execute(filters=None):
    if not filters:
        filters = {}
    
    columns = get_columns(filters)
    data = get_data(filters)
    
    return columns, data

def get_filters():
    """Define report filters"""
    return [
        {
            "fieldname": "company",
            "label": _("Company"),
            "fieldtype": "Link",
            "options": "Company",
            "default": frappe.defaults.get_user_default("Company"),
            "reqd": 1
        },
        {
            "fieldname": "to_date",
            "label": _("As On Date"),
            "fieldtype": "Date",
            "default": frappe.utils.today(),
            "reqd": 1
        },
        {
            "fieldname": "customer",
            "label": _("Customer"),
            "fieldtype": "Link",
            "options": "Customer"
        }
    ]

def get_columns(filters):
    """Define report columns dynamically based on months with data"""
    
    # Get filters with defaults
    company = filters.get("company") or frappe.defaults.get_user_default("Company")
    to_date = getdate(filters.get("to_date") or frappe.utils.today())
    customer_filter = filters.get("customer")
    
    # Get all unique month-years from invoices that still have outstanding
    customer_condition = " AND si.customer = %(customer)s" if customer_filter else ""
    
    month_years = frappe.db.sql("""
        SELECT DISTINCT 
            DATE_FORMAT(si.posting_date, '%%Y-%%m') as month_year,
            DATE_FORMAT(si.posting_date, '%%b %%Y') as display_month
        FROM 
            `tabSales Invoice` si
        WHERE 
            si.docstatus = 1
            AND si.company = %(company)s
            AND si.posting_date <= %(to_date)s
            {customer_condition}
        ORDER BY 
            month_year ASC
    """.format(customer_condition=customer_condition), {
        "company": company,
        "to_date": to_date,
        "customer": customer_filter
    }, as_dict=1)
    
    # Also get month-years from journal entries
    party_condition = " AND jea.party = %(customer)s" if customer_filter else ""
    
    je_month_years = frappe.db.sql("""
        SELECT DISTINCT 
            DATE_FORMAT(je.posting_date, '%%Y-%%m') as month_year,
            DATE_FORMAT(je.posting_date, '%%b %%Y') as display_month
        FROM 
            `tabJournal Entry Account` jea
        INNER JOIN 
            `tabJournal Entry` je ON jea.parent = je.name
        WHERE 
            je.docstatus = 1
            AND jea.party_type = 'Customer'
            AND jea.party IS NOT NULL
            AND je.company = %(company)s
            AND je.posting_date <= %(to_date)s
            {party_condition}
        ORDER BY 
            month_year ASC
    """.format(party_condition=party_condition), {
        "company": company,
        "to_date": to_date,
        "customer": customer_filter
    }, as_dict=1)
    
    # Combine and deduplicate month-years
    all_month_years = {}
    for row in month_years + je_month_years:
        all_month_years[row.month_year] = row.display_month
    
    # Sort by month_year
    sorted_month_years = OrderedDict(sorted(all_month_years.items()))
    
    # Base columns
    columns = [
        {
            "fieldname": "customer",
            "label": _("Customer"),
            "fieldtype": "Link",
            "options": "Customer",
            "width": 150
        },
        {
            "fieldname": "customer_name",
            "label": _("Customer Name"),
            "fieldtype": "Data",
            "width": 180
        }
    ]
    
    # Add dynamic month columns
    for month_year, display_month in sorted_month_years.items():
        columns.append({
            "fieldname": f"month_{month_year.replace('-', '_')}",
            "label": _(display_month),
            "fieldtype": "Currency",
            "width": 120
        })
    
    # Summary columns
    columns.extend([
        {
            "fieldname": "outstanding_amount",
            "label": _("Outstanding Amount"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "advance_amount",
            "label": _("Advance Amount"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "credit_note_amount",
            "label": _("Credit Note Amount"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "total_outstanding",
            "label": _("Total Outstanding"),
            "fieldtype": "Currency",
            "width": 150
        }
    ])
    
    return columns

def get_data(filters):
    """Get customer outstanding data with month-wise breakdown"""
    
    # Get filters with defaults
    if not filters:
        filters = {}
    
    company = filters.get("company") or frappe.defaults.get_user_default("Company")
    to_date = getdate(filters.get("to_date") or frappe.utils.today())
    customer_filter = filters.get("customer")
    
    if not company:
        frappe.throw(_("Please select a Company"))
    
    # Initialize data dictionary
    customer_data = {}
    
    # Build customer condition
    customer_condition = " AND customer = %(customer)s" if customer_filter else ""
    party_condition = " AND party = %(customer)s" if customer_filter else ""
    
    conditions = {
        "company": company,
        "to_date": to_date,
        "customer": customer_filter
    }
    
    # 1. SALES INVOICES - Get invoices with month-year breakdown
    invoices = frappe.db.sql("""
        SELECT 
            si.customer,
            si.customer_name,
            si.name as invoice_name,
            si.posting_date,
            DATE_FORMAT(si.posting_date, '%%Y-%%m') as month_year,
            si.grand_total,
            si.is_return,
            COALESCE((
                SELECT SUM(per.allocated_amount)
                FROM `tabPayment Entry Reference` per
                INNER JOIN `tabPayment Entry` pe ON per.parent = pe.name
                WHERE per.reference_doctype = 'Sales Invoice'
                    AND per.reference_name = si.name
                    AND pe.docstatus = 1
                    AND pe.posting_date <= %(to_date)s
            ), 0) as paid_amount,
            COALESCE((
                SELECT SUM(jea.credit - jea.debit)
                FROM `tabJournal Entry Account` jea
                INNER JOIN `tabJournal Entry` je ON jea.parent = je.name
                WHERE jea.reference_type = 'Sales Invoice'
                    AND jea.reference_name = si.name
                    AND je.docstatus = 1
                    AND je.posting_date <= %(to_date)s
            ), 0) as journal_adjusted
        FROM 
            `tabSales Invoice` si
        WHERE 
            si.docstatus = 1
            AND si.company = %(company)s
            AND si.posting_date <= %(to_date)s
            {customer_condition}
    """.format(customer_condition=customer_condition), conditions, as_dict=1)
    
    for inv in invoices:
        customer = inv.customer
        month_year = inv.month_year
        
        if customer not in customer_data:
            customer_data[customer] = {
                "customer": customer,
                "customer_name": inv.customer_name,
                "months": {},
                "outstanding_amount": 0,
                "advance_amount": 0,
                "credit_note_amount": 0
            }
        
        # Calculate outstanding as of to_date (SAME AS ORIGINAL)
        outstanding = flt(inv.grand_total) - flt(inv.paid_amount) - flt(inv.journal_adjusted)
        
        # Only add to month breakdown if there is still outstanding
        if outstanding != 0:
            # Initialize month if not exists
            if month_year not in customer_data[customer]["months"]:
                customer_data[customer]["months"][month_year] = 0
        
        if inv.is_return:
            # Credit notes with outstanding balance
            if outstanding < 0:  # Credit notes are negative
                customer_data[customer]["credit_note_amount"] += abs(outstanding)
                # Add to month breakdown for credit notes
                if month_year not in customer_data[customer]["months"]:
                    customer_data[customer]["months"][month_year] = 0
                customer_data[customer]["months"][month_year] -= abs(outstanding)
        else:
            # Regular invoices
            if outstanding > 0:
                customer_data[customer]["outstanding_amount"] += outstanding
                customer_data[customer]["months"][month_year] += outstanding
            elif outstanding < 0:
                # Overpayment
                customer_data[customer]["advance_amount"] += abs(outstanding)
    
    # 2. JOURNAL ENTRIES - Posted up to to_date with month breakdown
    journal_entries = frappe.db.sql("""
        SELECT 
            jea.party as customer,
            DATE_FORMAT(je.posting_date, '%%Y-%%m') as month_year,
            SUM(jea.debit - jea.credit) as net_amount
        FROM 
            `tabJournal Entry Account` jea
        INNER JOIN 
            `tabJournal Entry` je ON jea.parent = je.name
        WHERE 
            je.docstatus = 1
            AND jea.party_type = 'Customer'
            AND jea.party IS NOT NULL
            AND je.company = %(company)s
            AND je.posting_date <= %(to_date)s
            AND (jea.reference_type IS NULL OR jea.reference_type != 'Sales Invoice')
            {party_condition}
        GROUP BY 
            jea.party, month_year
        HAVING 
            net_amount != 0
    """.format(party_condition=party_condition), conditions, as_dict=1)
    
    for row in journal_entries:
        customer = row.customer
        month_year = row.month_year
        
        if customer not in customer_data:
            customer_name = frappe.db.get_value("Customer", customer, "customer_name")
            customer_data[customer] = {
                "customer": customer,
                "customer_name": customer_name,
                "months": {},
                "outstanding_amount": 0,
                "advance_amount": 0,
                "credit_note_amount": 0
            }
        
        # Initialize month if not exists
        if month_year not in customer_data[customer]["months"]:
            customer_data[customer]["months"][month_year] = 0
        
        net_amount = flt(row.net_amount)
        if net_amount > 0:
            customer_data[customer]["months"][month_year] += net_amount
            customer_data[customer]["outstanding_amount"] += net_amount
        else:
            customer_data[customer]["advance_amount"] += abs(net_amount)
            # Don't add negative JE amounts to month breakdown, keep advances separate
    
    # 3. UNALLOCATED PAYMENT ENTRIES - Posted up to to_date (SAME AS ORIGINAL)
    unallocated_payments = frappe.db.sql("""
        SELECT 
            pe.party as customer,
            pe.name as payment_entry,
            pe.paid_amount,
            COALESCE((
                SELECT SUM(per.allocated_amount)
                FROM `tabPayment Entry Reference` per
                WHERE per.parent = pe.name
            ), 0) as allocated_amount
        FROM 
            `tabPayment Entry` pe
        WHERE 
            pe.docstatus = 1
            AND pe.party_type = 'Customer'
            AND pe.payment_type = 'Receive'
            AND pe.company = %(company)s
            AND pe.posting_date <= %(to_date)s
            {party_condition}
    """.format(party_condition=party_condition), conditions, as_dict=1)
    
    for payment in unallocated_payments:
        customer = payment.customer
        
        if customer not in customer_data:
            customer_name = frappe.db.get_value("Customer", customer, "customer_name")
            customer_data[customer] = {
                "customer": customer,
                "customer_name": customer_name,
                "months": {},
                "outstanding_amount": 0,
                "advance_amount": 0,
                "credit_note_amount": 0
            }
        
        # Unallocated amount
        unallocated = flt(payment.paid_amount) - flt(payment.allocated_amount)
        
        if unallocated > 0:
            customer_data[customer]["advance_amount"] += unallocated
    
    # Prepare final data
    data = []
    for customer, values in customer_data.items():
        # Calculate total outstanding EXACTLY as original (Outstanding - Advance - Credit Note)
        total_outstanding = (
            flt(values["outstanding_amount"]) 
            - flt(values["advance_amount"]) 
            - flt(values["credit_note_amount"])
        )
        
        # Include all customers with any balance
        if (values["outstanding_amount"] != 0 or 
            values["advance_amount"] != 0 or 
            values["credit_note_amount"] != 0):
            
            row_data = {
                "customer": values["customer"],
                "customer_name": values["customer_name"],
                "outstanding_amount": flt(values["outstanding_amount"], 2),
                "advance_amount": flt(values["advance_amount"], 2),
                "credit_note_amount": flt(values["credit_note_amount"], 2),
                "total_outstanding": flt(total_outstanding, 2)
            }
            
            # Add month-wise data (only positive outstanding amounts)
            for month_year, amount in values["months"].items():
                field_name = f"month_{month_year.replace('-', '_')}"
                # Only show positive amounts in month columns (actual outstanding)
                if amount > 0:
                    row_data[field_name] = flt(amount, 2)
                else:
                    row_data[field_name] = 0
            
            data.append(row_data)
    
    # Sort by total outstanding (descending)
    data.sort(key=lambda x: x["total_outstanding"], reverse=True)
    
    return data