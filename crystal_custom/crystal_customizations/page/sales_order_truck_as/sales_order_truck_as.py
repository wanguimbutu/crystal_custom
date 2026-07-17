import frappe


@frappe.whitelist()
def get_truck_assignment_orders(from_date=None, to_date=None, sales_persons_json=None, regions_json=None):
    """
    Return truck-assigned and unassigned orders for the Truck Assignment page.
    SP filtering is done via SQL JOIN so it always works correctly.
    Returns sales_persons per order so the search box can filter by SP name.
    """
    import json
    sps     = json.loads(sales_persons_json) if sales_persons_json else []
    regions = json.loads(regions_json)        if regions_json        else []

    has_pf = frappe.db.has_column('Sales Order', 'custom_is_pre_fulfillment')
    pf_expr = (
        'IFNULL(so.custom_is_pre_fulfillment, 0) AS custom_is_pre_fulfillment'
        if has_pf else '0 AS custom_is_pre_fulfillment'
    )

    WF = ('Proceed To Order', 'Pending Finance Approval', 'Pending Customer Order Reconfirmation', 'Order Confirmed')

    # Build optional SP join / where clause
    sp_join  = ''
    sp_where = ''
    params   = {'wf': WF}
    if sps:
        sp_join  = 'INNER JOIN `tabSales Team` st ON st.parent = so.name AND st.parenttype = "Sales Order"'
        sp_ph    = ', '.join([f'%(sp{i})s' for i in range(len(sps))])
        sp_where = f'AND st.sales_person IN ({sp_ph})'
        for i, sp in enumerate(sps):
            params[f'sp{i}'] = sp

    select_cols = f"""
        so.name, so.customer, so.customer_name, so.transaction_date,
        so.grand_total, so.custom_delivery_region, so.owner,
        so.custom_truck_number, so.total_net_weight,
        IFNULL(so.custom_call_not_picked, 0) AS custom_call_not_picked,
        so.custom_call_notes,
        so.workflow_state, so.docstatus,
        {pf_expr},
        (SELECT GROUP_CONCAT(DISTINCT st2.sales_person
                             ORDER BY st2.sales_person SEPARATOR ', ')
         FROM `tabSales Team` st2
         WHERE st2.parent = so.name) AS sales_persons
    """

    region_where = ''
    if regions:
        rph = ', '.join([f'%(rgn{i})s' for i in range(len(regions))])
        region_where = f' AND so.custom_delivery_region IN ({rph})'
        for i, r in enumerate(regions):
            params[f'rgn{i}'] = r

    date_where = ''
    if from_date:
        params['from_date'] = from_date
        date_where += ' AND DATE(so.transaction_date) >= %(from_date)s'
    if to_date:
        params['to_date'] = to_date
        date_where += ' AND DATE(so.transaction_date) <= %(to_date)s'

    sp_region = f"{sp_where} {region_where}"

    # Truck-assigned: no date filter, no status filter — custom_truck_closed=1 is the sole signal
    # a trip is over. Completed/Closed orders stay visible on their truck (for value/weight review)
    # but the frontend badges them as "Invoiced" and prevents reassignment.
    assigned = frappe.db.sql(f"""
        SELECT DISTINCT {select_cols},
            so.status AS so_status
        FROM `tabSales Order` so {sp_join}
        WHERE so.docstatus IN (0, 1)
          AND (so.docstatus = 1 OR so.workflow_state IN %(wf)s)
          {sp_region}
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
          AND IFNULL(so.custom_truck_closed, 0) != 1
        ORDER BY so.transaction_date DESC
        LIMIT 500
    """, params, as_dict=1)

    # Unassigned orders: apply status + date filter so only open, actionable work appears
    unassigned = frappe.db.sql(f"""
        SELECT DISTINCT {select_cols}
        FROM `tabSales Order` so {sp_join}
        WHERE so.docstatus IN (0, 1)
          AND (so.docstatus = 1 OR so.workflow_state IN %(wf)s)
          AND so.status NOT IN ('Completed', 'Closed')
          {sp_region}
          {date_where}
          AND (so.custom_truck_number IS NULL OR so.custom_truck_number = '')
        ORDER BY so.transaction_date DESC
        LIMIT 1000
    """, params, as_dict=1)

    return {'assigned': [dict(r) for r in assigned], 'unassigned': [dict(r) for r in unassigned]}


@frappe.whitelist()
def set_truck_number(order_name, truck_number):
    frappe.db.set_value('Sales Order', order_name, {
        'custom_truck_number': truck_number or '',
        'custom_truck_closed': 0,
    })
    return True

@frappe.whitelist()
def set_pre_fulfillment(order_name, value=1):
    frappe.db.set_value('Sales Order', order_name, 'custom_is_pre_fulfillment', int(value))
    return True

@frappe.whitelist()
def set_truck_closed(order_name, value=1):
    frappe.db.set_value('Sales Order', order_name, 'custom_truck_closed', int(value))
    return True

@frappe.whitelist()
def close_truck_orders(order_names_json):
    """Batch-set custom_truck_closed=1 for all orders in a single DB call."""
    import json
    names = json.loads(order_names_json) if isinstance(order_names_json, str) else order_names_json
    if not names:
        return True
    ph = ', '.join(['%s'] * len(names))
    frappe.db.sql(
        f"UPDATE `tabSales Order` SET custom_truck_closed = 1 WHERE name IN ({ph})",
        names
    )
    frappe.db.commit()
    return True

@frappe.whitelist()
def save_truck_meta(trucks_json):
    """Persist truck metadata (driver name, capacity) so it survives page reloads."""
    frappe.db.set_default('crystal_truck_meta', trucks_json)
    frappe.db.commit()
    return True

@frappe.whitelist()
def get_truck_meta():
    """Return previously saved truck metadata as a JSON string."""
    return frappe.db.get_default('crystal_truck_meta') or '[]'

@frappe.whitelist()
def save_closed_trucks(closed_trucks_json):
    """Persist the list of closed truck records."""
    frappe.db.set_default('crystal_closed_trucks', closed_trucks_json)
    frappe.db.commit()
    return True

@frappe.whitelist()
def get_closed_trucks():
    """Return the persisted closed truck records."""
    return frappe.db.get_default('crystal_closed_trucks') or '[]'


@frappe.whitelist()
def create_truck_plan(truck_number, driver_name, capacity_kg, orders_json, closed_from):
    """Create and submit a Crystal Truck Plan for permanent data persistence."""
    import json
    orders = json.loads(orders_json)

    doc = frappe.get_doc({
        'doctype': 'Crystal Truck Plan',
        'truck_number': truck_number,
        'plan_date': frappe.utils.today(),
        'driver_name': driver_name or '',
        'capacity_kg': float(capacity_kg or 0),
        'closed_from': closed_from,
        'orders': [
            {
                'doctype': 'Crystal Truck Plan Order',
                'sales_order': o.get('name') or o.get('sales_order', ''),
                'customer_name': o.get('customer_name', ''),
                'delivery_region': o.get('delivery_region') or o.get('custom_delivery_region', ''),
                'grand_total': float(o.get('grand_total', 0)),
                'total_net_weight': float(o.get('total_net_weight', 0)),
            }
            for o in orders
        ],
    })
    doc.insert(ignore_permissions=True)
    doc.submit()
    frappe.db.commit()
    return doc.name


@frappe.whitelist()
def check_and_auto_close_trucks():
    """
    Check every active truck. If ALL assigned submitted orders are fully
    delivered (per_delivered >= 100) AND fully billed (per_billed >= 100),
    auto-close the truck: mark orders custom_truck_closed=1, prepend a
    closure record to crystal_closed_trucks, and remove from crystal_truck_meta.
    Returns a list of truck numbers that were auto-closed.
    """
    import json
    from collections import defaultdict

    rows = frappe.db.sql("""
        SELECT
            custom_truck_number,
            name,
            customer_name,
            custom_delivery_region,
            IFNULL(per_delivered,    0) AS per_delivered,
            IFNULL(per_billed,       0) AS per_billed,
            IFNULL(total_net_weight, 0) AS total_net_weight,
            IFNULL(grand_total,      0) AS grand_total
        FROM `tabSales Order`
        WHERE docstatus = 1
          AND custom_truck_number IS NOT NULL
          AND custom_truck_number != ''
          AND IFNULL(custom_truck_closed, 0) != 1
    """, as_dict=1)

    if not rows:
        return []

    trucks = defaultdict(list)
    for r in rows:
        trucks[r.custom_truck_number].append(r)

    to_close = [
        (tn, orders) for tn, orders in trucks.items()
        if all(float(o.per_delivered) >= 100 and float(o.per_billed) >= 100 for o in orders)
    ]

    if not to_close:
        return []

    existing_closed = json.loads(frappe.db.get_default('crystal_closed_trucks') or '[]')
    existing_meta   = json.loads(frappe.db.get_default('crystal_truck_meta')    or '[]')

    auto_closed = []
    for truck_num, orders in to_close:
        for o in orders:
            frappe.db.set_value('Sales Order', o.name, 'custom_truck_closed', 1)

        meta = next((m for m in existing_meta if m.get('truck_number') == truck_num), {})
        existing_closed.insert(0, {
            'truck_number': truck_num,
            'driver_name':  meta.get('driver_name', ''),
            'capacity_kg':  meta.get('capacity_kg', 0),
            'trip_id':      meta.get('trip_id', ''),
            'closed_at':    str(frappe.utils.now_datetime()),
            'order_count':  len(orders),
            'total_weight': sum(float(o.total_net_weight) for o in orders),
            'total_value':  sum(float(o.grand_total)      for o in orders),
            'auto_closed':  True,
            'orders': [
                {
                    'name':            o.name,
                    'customer_name':   o.customer_name or '',
                    'delivery_region': o.custom_delivery_region or '',
                }
                for o in orders
            ],
        })
        existing_meta = [m for m in existing_meta if m.get('truck_number') != truck_num]
        auto_closed.append(truck_num)

    frappe.db.set_default('crystal_closed_trucks', json.dumps(existing_closed))
    frappe.db.set_default('crystal_truck_meta',    json.dumps(existing_meta))
    frappe.db.commit()
    return auto_closed


@frappe.whitelist()
def cleanup_stale_completed_orders():
    """
    One-shot cleanup: mark all truck-assigned Completed/Closed orders as custom_truck_closed=1
    so they stop appearing on active trucks. Safe to run multiple times.
    """
    result = frappe.db.sql("""
        UPDATE `tabSales Order`
        SET custom_truck_closed = 1
        WHERE custom_truck_number IS NOT NULL
          AND custom_truck_number != ''
          AND IFNULL(custom_truck_closed, 0) != 1
          AND status IN ('Completed', 'Closed')
    """)
    frappe.db.commit()
    count = frappe.db.sql("SELECT ROW_COUNT()")[0][0]
    frappe.logger().info(f"cleanup_stale_completed_orders: marked {count} orders as truck_closed")
    return {'updated': count}
