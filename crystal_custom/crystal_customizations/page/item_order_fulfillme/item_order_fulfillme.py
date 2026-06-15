import frappe
from frappe import _

FINANCE_APPROVED_STATES = ('Pending Customer Order Reconfirmation', 'Order Confirmed')


@frappe.whitelist()
def get_sales_order_fulfillment(from_date=None, to_date=None):
    """
    Aggregate all finance-approved orders vs finished goods stock.
    Used by the Item Summary tab.
    """
    conditions = [
        "so.workflow_state IN %(states)s",
        "so.status NOT IN ('Completed', 'Closed')",
        "soi.qty > soi.delivered_qty",
    ]
    params = {'states': FINANCE_APPROVED_STATES}

    if from_date:
        conditions.append("so.transaction_date >= %(from_date)s")
        params['from_date'] = from_date
    if to_date:
        conditions.append("so.transaction_date <= %(to_date)s")
        params['to_date'] = to_date

    where_clause = " AND ".join(conditions)

    sales_order_items = frappe.db.sql(f"""
        SELECT
            soi.item_code,
            soi.item_name,
            SUM(soi.qty - soi.delivered_qty) as required_qty
        FROM `tabSales Order Item` soi
        INNER JOIN `tabSales Order` so ON soi.parent = so.name
        WHERE {where_clause}
        GROUP BY soi.item_code, soi.item_name
    """, params, as_dict=1)

    result = []
    for item in sales_order_items:
        available_qty = frappe.db.sql("""
            SELECT IFNULL(SUM(actual_qty), 0) as available_qty
            FROM `tabBin`
            WHERE item_code = %s
        """, (item.item_code,), as_dict=1)[0].available_qty

        shortage = item.required_qty - available_qty
        result.append({
            'item_code':    item.item_code,
            'item_name':    item.item_name,
            'required_qty': item.required_qty,
            'available_qty': available_qty,
            'shortage':     max(shortage, 0),
        })

    return sorted(result, key=lambda x: x['shortage'], reverse=True)


@frappe.whitelist()
def get_truck_fulfillment_data(from_date=None, to_date=None):
    """
    Return items grouped by truck for orders at Pending Customer Order Reconfirmation
    that have a truck assigned. Also returns current stock per unique item.
    """
    conditions = [
        "so.docstatus = 0",
        "so.workflow_state = 'Pending Customer Order Reconfirmation'",
        "so.status NOT IN ('Completed', 'Closed')",
        "so.custom_truck_number IS NOT NULL",
        "so.custom_truck_number != ''",
        "IFNULL(so.custom_truck_closed, 0) != 1",
        "soi.qty > IFNULL(soi.delivered_qty, 0)",
    ]
    params = {}

    if from_date:
        conditions.append("so.transaction_date >= %(from_date)s")
        params['from_date'] = from_date
    if to_date:
        conditions.append("so.transaction_date <= %(to_date)s")
        params['to_date'] = to_date

    where = " AND ".join(conditions)

    rows = frappe.db.sql(f"""
        SELECT
            so.custom_truck_number                              AS truck_number,
            so.name                                             AS sales_order,
            so.customer_name,
            soi.item_code,
            soi.item_name,
            SUM(soi.qty - IFNULL(soi.delivered_qty, 0))        AS required_qty,
            soi.uom,
            IFNULL(soi.weight_per_unit, 0)                     AS weight_per_unit
        FROM `tabSales Order` so
        INNER JOIN `tabSales Order Item` soi ON soi.parent = so.name
        WHERE {where}
        GROUP BY so.custom_truck_number, so.name, soi.item_code
        ORDER BY so.custom_truck_number, soi.item_code
    """, params, as_dict=1)

    if not rows:
        return {'trucks': [], 'stock': {}}

    # Unique items for one stock lookup
    unique_items = list({r.item_code for r in rows})
    item_ph = ', '.join(['%s'] * len(unique_items))
    stock_rows = frappe.db.sql(
        f"SELECT item_code, IFNULL(SUM(actual_qty),0) AS available_qty "
        f"FROM `tabBin` WHERE item_code IN ({item_ph}) GROUP BY item_code",
        unique_items, as_dict=1,
    )
    stock_map   = {s.item_code: float(s.available_qty) for s in stock_rows}
    item_names  = {r.item_code: r.item_name for r in rows}
    item_uoms   = {r.item_code: r.uom       for r in rows}

    # Group by truck → item (aggregate across orders in that truck)
    from collections import defaultdict
    trucks_map = defaultdict(lambda: {'orders': {}, 'items': defaultdict(float)})
    for r in rows:
        tn = r.truck_number
        trucks_map[tn]['orders'][r.sales_order] = {
            'name': r.sales_order,
            'customer_name': r.customer_name or r.sales_order,
        }
        trucks_map[tn]['items'][r.item_code] += float(r.required_qty)

    # Truck meta (weight + value)
    meta_rows = frappe.db.sql(f"""
        SELECT
            so.custom_truck_number  AS truck_number,
            SUM(so.total_net_weight) AS total_weight,
            SUM(so.grand_total)      AS total_value,
            COUNT(so.name)           AS order_count
        FROM `tabSales Order` so
        WHERE so.docstatus = 0
          AND so.workflow_state = 'Pending Customer Order Reconfirmation'
          AND so.status NOT IN ('Completed', 'Closed')
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
          AND IFNULL(so.custom_truck_closed, 0) != 1
        GROUP BY so.custom_truck_number
    """, as_dict=1) if params == {} else frappe.db.sql(f"""
        SELECT
            so.custom_truck_number  AS truck_number,
            SUM(so.total_net_weight) AS total_weight,
            SUM(so.grand_total)      AS total_value,
            COUNT(so.name)           AS order_count
        FROM `tabSales Order` so
        WHERE so.docstatus = 0
          AND so.workflow_state = 'Pending Customer Order Reconfirmation'
          AND so.status NOT IN ('Completed', 'Closed')
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
          AND IFNULL(so.custom_truck_closed, 0) != 1
          {'AND so.transaction_date >= %(from_date)s' if from_date else ''}
          {'AND so.transaction_date <= %(to_date)s'   if to_date   else ''}
        GROUP BY so.custom_truck_number
    """, params, as_dict=1)

    meta_map = {r.truck_number: r for r in meta_rows}

    trucks = []
    for tn in sorted(trucks_map.keys()):
        data = trucks_map[tn]
        meta = meta_map.get(tn, {})
        trucks.append({
            'truck_number': tn,
            'order_count':  len(data['orders']),
            'orders':       list(data['orders'].values()),
            'total_weight': float(meta.get('total_weight') or 0),
            'total_value':  float(meta.get('total_value')  or 0),
            'items': [
                {
                    'item_code':    ic,
                    'item_name':    item_names.get(ic, ic),
                    'required_qty': qty,
                    'uom':          item_uoms.get(ic, ''),
                }
                for ic, qty in sorted(data['items'].items())
            ],
        })

    stock = {
        ic: {
            'available_qty': stock_map.get(ic, 0),
            'item_name':     item_names.get(ic, ic),
            'uom':           item_uoms.get(ic, ''),
        }
        for ic in unique_items
    }

    return {'trucks': trucks, 'stock': stock}


@frappe.whitelist()
def create_requisition_from_shortage_items(shortage_items):
    """
    Create a draft Manufacture Material Request from a list of shortage items.
    shortage_items: JSON list of {item_code, item_name, shortage_qty, uom}
    """
    import json
    if isinstance(shortage_items, str):
        shortage_items = json.loads(shortage_items)

    items = [i for i in shortage_items if float(i.get('shortage_qty') or 0) > 0]
    if not items:
        frappe.throw(_('No shortages to requisition'))

    mr = frappe.new_doc('Material Request')
    mr.material_request_type = 'Manufacture'
    mr.transaction_date = frappe.utils.today()
    mr.schedule_date    = frappe.utils.add_days(frappe.utils.today(), 7)

    for item in items:
        warehouse = (
            frappe.db.get_value('Item Default', {'parent': item['item_code']}, 'default_warehouse')
            or frappe.db.get_value('Warehouse', {'is_group': 0, 'disabled': 0}, 'name')
        )
        mr.append('items', {
            'item_code':     item['item_code'],
            'qty':           float(item['shortage_qty']),
            'uom':           item.get('uom', ''),
            'schedule_date': mr.schedule_date,
            'warehouse':     warehouse,
        })

    mr.insert(ignore_permissions=False)
    return mr.name


@frappe.whitelist()
def create_material_request_from_shortage(from_date=None, to_date=None):
    """Legacy: create MR from item summary shortages (Item Summary tab)."""
    fulfillment_data = get_sales_order_fulfillment(from_date=from_date, to_date=to_date)
    shortage_items = [
        {'item_code': i['item_code'], 'item_name': i['item_name'],
         'shortage_qty': i['shortage'], 'uom': ''}
        for i in fulfillment_data if i['shortage'] > 0
    ]
    return create_requisition_from_shortage_items(shortage_items)


def get_default_warehouse_for_manufacture(item_code):
    warehouse = frappe.db.get_value('Item Default', {'parent': item_code}, 'default_warehouse')
    if warehouse:
        return warehouse
    return frappe.db.get_value('Warehouse', {'is_group': 0, 'disabled': 0}, 'name')
