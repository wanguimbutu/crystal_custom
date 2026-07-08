import frappe


@frappe.whitelist()
def get_daily_orders(from_date, to_date, sales_persons_json=None, sales_persons=None, delivery_region=None):
    import json

    # Accept both the new JSON-string form and the old array/string form
    raw = sales_persons_json or sales_persons
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            sps = parsed if isinstance(parsed, list) else ([parsed] if parsed else [])
        except (json.JSONDecodeError, ValueError, TypeError):
            sps = [raw] if raw else []
    elif isinstance(raw, list):
        sps = [s for s in raw if s]
    else:
        sps = []

    conditions = [
        "so.docstatus != 2",
        "DATE(so.transaction_date) BETWEEN %(from_date)s AND %(to_date)s",
    ]
    params = {'from_date': from_date, 'to_date': to_date}

    if sps:
        placeholders = ', '.join(f'%(sp{i})s' for i in range(len(sps)))
        conditions.append(f"""
            EXISTS (
                SELECT 1 FROM `tabSales Team` sp_f
                WHERE sp_f.parent = so.name
                  AND sp_f.parenttype = 'Sales Order'
                  AND sp_f.sales_person IN ({placeholders})
            )
        """)
        for i, sp in enumerate(sps):
            params[f'sp{i}'] = sp

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
                SELECT GROUP_CONCAT(DISTINCT st2.sales_person ORDER BY st2.sales_person SEPARATOR ', ')
                FROM `tabSales Team` st2
                WHERE st2.parent = so.name AND st2.parenttype = 'Sales Order'
            ) AS sales_person
        FROM `tabSales Order` so
        WHERE {where_clause}
        ORDER BY so.transaction_date DESC, so.creation DESC
    """, params, as_dict=1)

    return orders
