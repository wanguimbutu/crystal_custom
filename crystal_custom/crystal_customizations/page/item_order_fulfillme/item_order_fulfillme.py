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
def get_truck_fulfillment_data():
    """
    Return items grouped by truck — NOT date-filtered so the truck list always
    matches truck assignment. Includes closed trucks (is_closed=True).
    Stock is always current (from tabBin at call time).
    """
    # Show ALL truck-assigned orders regardless of status, workflow state, or docstatus
    # Only exclude cancelled (docstatus=2) orders
    rows = frappe.db.sql("""
        SELECT
            so.custom_truck_number                                          AS truck_number,
            so.name                                                         AS sales_order,
            so.customer_name,
            so.custom_paint_notes,
            MAX(IFNULL(so.custom_truck_closed, 0))                          AS is_closed,
            soi.item_code,
            soi.item_name,
            GREATEST(0, SUM(soi.qty - IFNULL(soi.delivered_qty, 0)))       AS required_qty,
            soi.uom,
            IFNULL(soi.weight_per_unit, 0)                                  AS weight_per_unit
        FROM `tabSales Order` so
        INNER JOIN `tabSales Order Item` soi ON soi.parent = so.name
        WHERE so.docstatus != 2
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
        GROUP BY so.custom_truck_number, so.name, soi.item_code
        ORDER BY so.custom_truck_number, soi.item_code
    """, as_dict=1)

    if not rows:
        return {'trucks': [], 'stock': {}}

    # Unique items still needing stock (required_qty > 0) for stock lookup
    unique_items = list({r.item_code for r in rows if float(r.required_qty) > 0})
    stock_map  = {}
    if unique_items:
        item_ph = ', '.join(['%s'] * len(unique_items))
        stock_rows = frappe.db.sql(
            f"SELECT item_code, IFNULL(SUM(actual_qty),0) AS available_qty "
            f"FROM `tabBin` WHERE item_code IN ({item_ph}) GROUP BY item_code",
            unique_items, as_dict=1,
        )
        stock_map = {s.item_code: float(s.available_qty) for s in stock_rows}
    item_names = {r.item_code: r.item_name for r in rows}
    item_uoms  = {r.item_code: r.uom       for r in rows}

    from collections import defaultdict
    trucks_map = defaultdict(lambda: {'orders': {}, 'items': defaultdict(float), 'is_closed': False})
    for r in rows:
        tn = r.truck_number
        # Always add the order (even if all items delivered) so order count matches truck assignment
        trucks_map[tn]['orders'][r.sales_order] = {
            'name':          r.sales_order,
            'customer_name': r.customer_name or r.sales_order,
            'paint_notes':   r.custom_paint_notes or '',
        }
        # Only accumulate items that still need to be fulfilled
        if float(r.required_qty) > 0:
            trucks_map[tn]['items'][r.item_code] += float(r.required_qty)
        if r.is_closed:
            trucks_map[tn]['is_closed'] = True

    # Truck meta (weight + value + regions), no date filter
    meta_rows = frappe.db.sql("""
        SELECT
            so.custom_truck_number   AS truck_number,
            SUM(so.total_net_weight) AS total_weight,
            SUM(so.grand_total)      AS total_value,
            COUNT(so.name)           AS order_count,
            MAX(IFNULL(so.custom_truck_closed, 0)) AS is_closed,
            GROUP_CONCAT(DISTINCT so.custom_delivery_region
                         ORDER BY so.custom_delivery_region
                         SEPARATOR ', ')            AS delivery_regions
        FROM `tabSales Order` so
        WHERE so.docstatus != 2
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
        GROUP BY so.custom_truck_number
    """, as_dict=1)
    meta_map = {r.truck_number: r for r in meta_rows}

    trucks = []
    for tn in sorted(trucks_map.keys()):
        data = trucks_map[tn]
        meta = meta_map.get(tn, {})
        trucks.append({
            'truck_number':     tn,
            'order_count':      len(data['orders']),
            'orders':           list(data['orders'].values()),
            'total_weight':     float(meta.get('total_weight') or 0),
            'total_value':      float(meta.get('total_value')  or 0),
            'is_closed':        bool(data['is_closed']),
            'delivery_regions': meta.get('delivery_regions') or '',
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
def get_truck_customer_data():
    """
    Return per-order item breakdown grouped by truck — NOT date-filtered.
    Includes closed trucks. Stock is always current.
    Used by the Customer View tab.
    """
    # Show ALL truck-assigned orders regardless of status or workflow state
    # Only exclude cancelled (docstatus=2) orders
    rows = frappe.db.sql("""
        SELECT
            so.custom_truck_number                                          AS truck_number,
            so.name                                                         AS sales_order,
            so.customer,
            so.customer_name,
            so.grand_total,
            so.total_net_weight,
            so.custom_paint_notes,
            IFNULL(so.custom_truck_closed, 0)                               AS is_closed,
            soi.item_code,
            soi.item_name,
            GREATEST(0, SUM(soi.qty - IFNULL(soi.delivered_qty, 0)))       AS required_qty,
            soi.uom
        FROM `tabSales Order` so
        INNER JOIN `tabSales Order Item` soi ON soi.parent = so.name
        WHERE so.docstatus != 2
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
        GROUP BY so.custom_truck_number, so.name, soi.item_code
        ORDER BY so.custom_truck_number, so.customer_name, so.name, soi.item_code
    """, as_dict=1)

    if not rows:
        return {'trucks': [], 'stock': {}}

    # Unique items still needing fulfillment for stock lookup
    unique_items = list({r.item_code for r in rows if float(r.required_qty) > 0})
    stock_map = {}
    if unique_items:
        item_ph = ', '.join(['%s'] * len(unique_items))
        stock_rows = frappe.db.sql(
            f"SELECT item_code, IFNULL(SUM(actual_qty), 0) AS available_qty "
            f"FROM `tabBin` WHERE item_code IN ({item_ph}) GROUP BY item_code",
            unique_items, as_dict=1,
        )
        stock_map = {s.item_code: float(s.available_qty) for s in stock_rows}

    # Group truck → order → items (only items with pending qty)
    from collections import OrderedDict
    trucks_map = OrderedDict()
    for r in rows:
        tn = r.truck_number
        on = r.sales_order
        if tn not in trucks_map:
            trucks_map[tn] = OrderedDict()
        if on not in trucks_map[tn]:
            trucks_map[tn][on] = {
                'name':             on,
                'customer':         r.customer,
                'customer_name':    r.customer_name or on,
                'grand_total':      float(r.grand_total or 0),
                'total_net_weight': float(r.total_net_weight or 0),
                'paint_notes':      r.custom_paint_notes or '',
                'is_closed':        bool(r.is_closed),
                'items':            [],
            }
        # Only include items with outstanding quantity
        if float(r.required_qty) > 0:
            trucks_map[tn][on]['items'].append({
                'item_code':    r.item_code,
                'item_name':    r.item_name,
                'required_qty': float(r.required_qty),
                'uom':          r.uom,
            })

    trucks = []
    for tn, orders_dict in trucks_map.items():
        orders_list = list(orders_dict.values())
        trucks.append({
            'truck_number': tn,
            'is_closed':    any(o.get('is_closed') for o in orders_list),
            'orders':       orders_list,
        })

    stock = {ic: float(stock_map.get(ic, 0)) for ic in unique_items}
    return {'trucks': trucks, 'stock': stock}


@frappe.whitelist()
def close_truck(truck_number):
    """
    Manually close a truck from the Order Fulfillment page:
    set custom_truck_closed=1 on all its orders and record it in
    crystal_closed_trucks.
    """
    import json as _json

    orders = frappe.db.sql(
        """SELECT name, customer_name, custom_delivery_region, total_net_weight, grand_total
           FROM `tabSales Order`
           WHERE custom_truck_number = %s AND docstatus != 2""",
        truck_number, as_dict=1
    )
    for o in orders:
        frappe.db.set_value('Sales Order', o.name, 'custom_truck_closed', 1, update_modified=False)

    existing_closed = _json.loads(frappe.db.get_default('crystal_closed_trucks') or '[]')
    existing_meta   = _json.loads(frappe.db.get_default('crystal_truck_meta')    or '[]')

    # Avoid duplicate entries
    existing_closed = [ct for ct in existing_closed if ct.get('truck_number') != truck_number]
    meta = next((m for m in existing_meta if m.get('truck_number') == truck_number), {})

    existing_closed.insert(0, {
        'truck_number': truck_number,
        'driver_name':  meta.get('driver_name', ''),
        'capacity_kg':  meta.get('capacity_kg', 0),
        'closed_at':    str(frappe.utils.now_datetime()),
        'order_count':  len(orders),
        'total_weight': sum(float(o.total_net_weight or 0) for o in orders),
        'total_value':  sum(float(o.grand_total or 0)      for o in orders),
        'orders': [
            {
                'name':            o.name,
                'customer_name':   o.customer_name or '',
                'delivery_region': o.custom_delivery_region or '',
            }
            for o in orders
        ],
    })
    frappe.db.set_default('crystal_closed_trucks', _json.dumps(existing_closed))
    frappe.db.commit()
    return 'ok'


@frappe.whitelist()
def reopen_truck(truck_number):
    """
    Reopen a closed truck: set custom_truck_closed=0 on all its orders
    and remove it from the crystal_closed_trucks KV store.
    """
    import json as _json
    frappe.db.sql(
        "UPDATE `tabSales Order` SET custom_truck_closed = 0 WHERE custom_truck_number = %s",
        truck_number
    )
    # Remove from closed trucks list if present
    closed_raw = frappe.db.get_default('crystal_closed_trucks') or '[]'
    try:
        closed = _json.loads(closed_raw)
    except Exception:
        closed = []
    closed = [ct for ct in closed if ct.get('truck_number') != truck_number]
    frappe.db.set_default('crystal_closed_trucks', _json.dumps(closed))
    frappe.db.commit()
    return 'ok'


@frappe.whitelist()
def save_allocations(allocations_json):
    """Persist truck-item allocation map across page loads."""
    frappe.db.set_default('crystal_fulfillment_alloc', allocations_json)
    frappe.db.commit()
    return True


@frappe.whitelist()
def get_allocations():
    """Return previously saved allocation map."""
    return frappe.db.get_default('crystal_fulfillment_alloc') or '{}'


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
