# Copyright (c) 2025, Crystal Customizations
# License: MIT
# Outstanding Debts Report with As On Date filter

import frappe
from frappe import _
from frappe.utils import flt, getdate

def execute(filters=None):
    columns = get_columns()
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

def get_columns():
    """Define report columns"""
    return [
        {
            "fieldname": "customer",
            "label": _("Customer"),
            "fieldtype": "Link",
            "options": "Customer",
            "width": 200
        },
        {
            "fieldname": "customer_name",
            "label": _("Customer Name"),
            "fieldtype": "Data",
            "width": 180
        },
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
    ]

def get_data(filters):
    """Get customer outstanding data as of a specific date"""
    
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
    
    # 1. SALES INVOICES - Get invoices posted up to to_date
    # Calculate outstanding by subtracting payments made up to to_date
    invoices = frappe.db.sql("""
        SELECT 
            si.customer,
            si.customer_name,
            si.name as invoice_name,
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
        
        if customer not in customer_data:
            customer_data[customer] = {
                "customer": customer,
                "customer_name": inv.customer_name,
                "outstanding_amount": 0,
                "advance_amount": 0,
                "credit_note_amount": 0
            }
        
        # Calculate outstanding as of to_date
        outstanding = flt(inv.grand_total) - flt(inv.paid_amount) - flt(inv.journal_adjusted)
        
        if inv.is_return:
            # Credit notes with outstanding balance
            if outstanding < 0:  # Credit notes are negative
                customer_data[customer]["credit_note_amount"] += abs(outstanding)
        else:
            # Regular invoices
            if outstanding > 0:
                customer_data[customer]["outstanding_amount"] += outstanding
            elif outstanding < 0:
                # Overpayment
                customer_data[customer]["advance_amount"] += abs(outstanding)
    
    # 2. JOURNAL ENTRIES - Posted up to to_date (excluding those already linked to invoices)
    journal_entries = frappe.db.sql("""
        SELECT 
            jea.party as customer,
            jea.party_name as customer_name,
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
            jea.party
        HAVING 
            net_amount != 0
    """.format(party_condition=party_condition), conditions, as_dict=1)
    
    for row in journal_entries:
        customer = row.customer
        
        if customer not in customer_data:
            customer_name = row.customer_name or frappe.db.get_value("Customer", customer, "customer_name")
            customer_data[customer] = {
                "customer": customer,
                "customer_name": customer_name,
                "outstanding_amount": 0,
                "advance_amount": 0,
                "credit_note_amount": 0
            }
        
        net_amount = flt(row.net_amount)
        if net_amount > 0:
            customer_data[customer]["outstanding_amount"] += net_amount
        else:
            customer_data[customer]["advance_amount"] += abs(net_amount)
    
    # 3. UNALLOCATED PAYMENT ENTRIES - Posted up to to_date
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
        total_outstanding = (
            flt(values["outstanding_amount"]) 
            - flt(values["advance_amount"]) 
            - flt(values["credit_note_amount"])
        )
        
        # Include all customers with any balance
        if (values["outstanding_amount"] != 0 or 
            values["advance_amount"] != 0 or 
            values["credit_note_amount"] != 0):
            
            data.append({
                "customer": values["customer"],
                "customer_name": values["customer_name"],
                "outstanding_amount": flt(values["outstanding_amount"], 2),
                "advance_amount": flt(values["advance_amount"], 2),
                "credit_note_amount": flt(values["credit_note_amount"], 2),
                "total_outstanding": flt(total_outstanding, 2)
            })
    
    # Sort by total outstanding (descending)
    data.sort(key=lambda x: x["total_outstanding"], reverse=True)
    
    return data