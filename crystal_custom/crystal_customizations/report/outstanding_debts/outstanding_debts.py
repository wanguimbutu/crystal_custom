# Copyright (c) 2025, Crystal Customizations
# License: MIT
# Outstanding Debts Report - GL-BASED (Always Accurate)

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

def get_columns(filters):
    """Define report columns"""
    
    # Get filters with defaults
    company = filters.get("company") or frappe.defaults.get_user_default("Company")
    from_date = filters.get("from_date")
    to_date = getdate(filters.get("to_date") or frappe.utils.today())
    sales_person_filter = filters.get("sales_person")
    
    # Build sales person filter
    sales_person_join = ""
    sales_person_condition = ""
    if sales_person_filter:
        sales_person_join = """
            INNER JOIN `tabSales Team` st_filter 
                ON st_filter.parent = gl.party 
                AND st_filter.parenttype = 'Customer'
        """
        sales_person_condition = " AND st_filter.sales_person = %(sales_person_filter)s"
    
    # Get unique month-years from GL entries
    from_date_condition = " AND gl.posting_date >= %(from_date)s" if from_date else ""
    
    month_years = frappe.db.sql("""
        SELECT DISTINCT 
            DATE_FORMAT(gl.posting_date, '%%Y-%%m') as month_year,
            DATE_FORMAT(gl.posting_date, '%%b %%Y') as display_month
        FROM 
            `tabGL Entry` gl
            {sales_person_join}
        WHERE 
            gl.party_type = 'Customer'
            AND gl.party IS NOT NULL
            AND gl.company = %(company)s
            AND gl.posting_date <= %(to_date)s
            {from_date_condition}
            AND gl.is_cancelled = 0
            {sales_person_condition}
        ORDER BY 
            month_year ASC
    """.format(
        sales_person_join=sales_person_join,
        from_date_condition=from_date_condition,
        sales_person_condition=sales_person_condition
    ), {
        "company": company,
        "from_date": from_date,
        "to_date": to_date,
        "sales_person_filter": sales_person_filter
    }, as_dict=1)
    
    # Sort by month_year
    sorted_month_years = OrderedDict((row.month_year, row.display_month) for row in month_years)
    
    # Base columns
    columns = [
        {
            "fieldname": "sales_person",
            "label": _("Sales Person"),
            "fieldtype": "Data",
            "width": 150
        },
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
            "fieldname": "total_outstanding",
            "label": _("Total Outstanding"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "pdc_amount",
            "label": _("PDC Amount"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "net_outstanding",
            "label": _("Net Outstanding"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "overdue_amount",
            "label": _("Overdue Amount"),
            "fieldtype": "Currency",
            "width": 150
        }
    ])
    
    return columns

def get_customer_sales_person(customer):
    """Get primary sales person for a customer"""
    sales_team = frappe.db.sql("""
        SELECT st.sales_person
        FROM `tabSales Team` st
        WHERE st.parent = %(customer)s
            AND st.parenttype = 'Customer'
        ORDER BY st.allocated_percentage DESC
        LIMIT 1
    """, {"customer": customer}, as_dict=1)
    
    if sales_team and sales_team[0].sales_person:
        return sales_team[0].sales_person
    
    return ""

def get_customer_pdc_amount(customer, company, to_date):
    """Get total PDC (draft payment entries) amount for a customer - only future dated from to_date"""
    pdc_payments = frappe.db.sql("""
        SELECT 
            SUM(pe.paid_amount) as total_pdc,
            COUNT(pe.name) as pdc_count
        FROM 
            `tabPayment Entry` pe
        WHERE 
            pe.docstatus = 0
            AND pe.party_type = 'Customer'
            AND pe.party = %(customer)s
            AND pe.payment_type = 'Receive'
            AND pe.company = %(company)s
            AND (pe.reference_date >= %(to_date)s OR pe.posting_date >= %(to_date)s)
    """, {
        "customer": customer,
        "company": company,
        "to_date": to_date
    }, as_dict=1)
    
    if pdc_payments and pdc_payments[0].total_pdc:
        return flt(pdc_payments[0].total_pdc)
    
    return 0

def get_customer_overdue(customer, company, to_date):
    """Get overdue amount from unpaid invoices past due date"""
    overdue = frappe.db.sql("""
        SELECT 
            SUM(si.outstanding_amount) as overdue
        FROM 
            `tabSales Invoice` si
        WHERE 
            si.customer = %(customer)s
            AND si.company = %(company)s
            AND si.docstatus = 1
            AND si.outstanding_amount > 0
            AND si.due_date < %(to_date)s
    """, {
        "customer": customer,
        "company": company,
        "to_date": to_date
    }, as_dict=1)
    
    return flt(overdue[0].overdue) if overdue and overdue[0].overdue else 0

def get_data(filters):
    """Get customer outstanding data FROM GL ENTRIES (100% accurate)"""
    
    # Get filters with defaults
    if not filters:
        filters = {}
    
    company = filters.get("company") or frappe.defaults.get_user_default("Company")
    from_date = filters.get("from_date")
    to_date = getdate(filters.get("to_date") or frappe.utils.today())
    sales_person_filter = filters.get("sales_person")
    
    if not company:
        frappe.throw(_("Please select a Company"))
    
    # Build filter conditions
    from_date_condition = " AND gl.posting_date >= %(from_date)s" if from_date else ""
    
    # Build sales person filter
    sales_person_join = ""
    sales_person_condition = ""
    if sales_person_filter:
        sales_person_join = """
            INNER JOIN `tabSales Team` st_filter 
                ON st_filter.parent = gl.party 
                AND st_filter.parenttype = 'Customer'
        """
        sales_person_condition = " AND st_filter.sales_person = %(sales_person_filter)s"
    
    conditions = {
        "company": company,
        "from_date": from_date,
        "to_date": to_date,
        "sales_person_filter": sales_person_filter
    }
    
    # Get outstanding from GL - This is the SOURCE OF TRUTH
    gl_data = frappe.db.sql("""
        SELECT 
            gl.party as customer,
            DATE_FORMAT(gl.posting_date, '%%Y-%%m') as month_year,
            SUM(gl.debit - gl.credit) as net_amount
        FROM 
            `tabGL Entry` gl
            {sales_person_join}
        WHERE 
            gl.party_type = 'Customer'
            AND gl.party IS NOT NULL
            AND gl.company = %(company)s
            AND gl.posting_date <= %(to_date)s
            {from_date_condition}
            AND gl.is_cancelled = 0
            {sales_person_condition}
        GROUP BY 
            gl.party, month_year
        HAVING 
            net_amount != 0
    """.format(
        sales_person_join=sales_person_join,
        from_date_condition=from_date_condition,
        sales_person_condition=sales_person_condition
    ), conditions, as_dict=1)
    
    # Process GL data
    customer_data = {}
    
    for row in gl_data:
        customer = row.customer
        month_year = row.month_year
        net_amount = flt(row.net_amount)
        
        if customer not in customer_data:
            customer_name = frappe.db.get_value("Customer", customer, "customer_name")
            sales_person = get_customer_sales_person(customer)
            pdc_amount = get_customer_pdc_amount(customer, company, to_date)
            overdue_amount = get_customer_overdue(customer, company, to_date)
            
            customer_data[customer] = {
                "customer": customer,
                "customer_name": customer_name,
                "sales_person": sales_person,
                "pdc_amount": pdc_amount,
                "overdue_amount": overdue_amount,
                "months": {},
                "total_outstanding": 0
            }
        
        # Add to month bucket
        if month_year not in customer_data[customer]["months"]:
            customer_data[customer]["months"][month_year] = 0
        customer_data[customer]["months"][month_year] += net_amount
        
        # Add to total
        customer_data[customer]["total_outstanding"] += net_amount
    
    # Prepare final data
    data = []
    for customer, values in customer_data.items():
        # Apply sales person filter if specified
        if sales_person_filter:
            customer_sp = values.get("sales_person", "")
            if not customer_sp or customer_sp != sales_person_filter:
                continue
        
        total_outstanding = flt(values["total_outstanding"])
        
        # Calculate net outstanding (total outstanding - PDC)
        net_outstanding = total_outstanding - flt(values["pdc_amount"])
        
        # Include customers with non-zero balance
        if total_outstanding != 0:
            row_data = {
                "sales_person": values["sales_person"],
                "customer": values["customer"],
                "customer_name": values["customer_name"],
                "total_outstanding": flt(total_outstanding, 2),
                "pdc_amount": flt(values["pdc_amount"], 2),
                "net_outstanding": flt(net_outstanding, 2),
                "overdue_amount": flt(values["overdue_amount"], 2)
            }
            
            # Add month-wise data
            for month_year, amount in values["months"].items():
                field_name = f"month_{month_year.replace('-', '_')}"
                row_data[field_name] = flt(amount, 2)
            
            data.append(row_data)
    
    # Sort by total outstanding (descending)
    data.sort(key=lambda x: x["total_outstanding"], reverse=True)
    
    return data