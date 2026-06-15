import frappe


@frappe.whitelist()
def get_daily_orders(from_date, to_date, sales_person=None, delivery_region=None):
    conditions = [
        "so.docstatus != 2",
        "so.transaction_date BETWEEN %(from_date)s AND %(to_date)s",
    ]
    params = {'from_date': from_date, 'to_date': to_date}

    sp_join = ""
    if sales_person:
        sp_join = (
            "INNER JOIN `tabSales Team` sp_f "
            "ON sp_f.parent = so.name AND sp_f.parenttype = 'Sales Order' "
            "AND sp_f.sales_person = %(sales_person)s"
        )
        params['sales_person'] = sales_person

    if delivery_region:
        conditions.append("so.custom_delivery_region = %(delivery_region)s")
        params['delivery_region'] = delivery_region

    where_clause = " AND ".join(conditions)

    orders = frappe.db.sql(f"""
        SELECT DISTINCT
            so.name,
            so.customer,
            so.customer_name,
            so.transaction_date,
            so.grand_total,
            so.custom_delivery_region,
            so.custom_phone_number,
            so.workflow_state,
            so.docstatus,
            so.status,
            so.custom_truck_number,
            so.total_net_weight,
            so.per_delivered,
            so.per_billed,
            (
                SELECT st.sales_person
                FROM `tabSales Team` st
                WHERE st.parent = so.name AND st.parenttype = 'Sales Order'
                LIMIT 1
            ) AS sales_person
        FROM `tabSales Order` so
        {sp_join}
        WHERE {where_clause}
        ORDER BY so.transaction_date DESC, so.creation DESC
    """, params, as_dict=1)

    return orders
