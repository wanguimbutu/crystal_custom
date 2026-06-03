import frappe
from frappe import _
from collections import defaultdict


@frappe.whitelist()
def get_orders_with_stock_summary(sales_person=None):
    """
    Return all Sales Orders at Pending Customer Order Reconfirmation with a
    per-order stock status:
      ok      – every item has enough stock
      partial – some items OK, some short
      none    – all items are short
    """
    conditions = [
        "so.docstatus = 0",
        "so.workflow_state = 'Pending Customer Order Reconfirmation'",
    ]
    params = {}

    if sales_person:
        conditions.append(
            "so.name IN (SELECT parent FROM `tabSales Team` WHERE sales_person = %(sales_person)s)"
        )
        params["sales_person"] = sales_person

    where = " AND ".join(conditions)

    orders = frappe.db.sql(
        f"""
        SELECT
            so.name, so.customer, so.customer_name, so.transaction_date,
            so.grand_total, so.custom_delivery_region, so.custom_truck_number,
            so.total_net_weight, so.owner
        FROM `tabSales Order` so
        WHERE {where}
        ORDER BY so.transaction_date DESC
        LIMIT 500
        """,
        params,
        as_dict=1,
    )

    if not orders:
        return []

    order_names = [o.name for o in orders]
    name_ph = ", ".join(["%s"] * len(order_names))

    items = frappe.db.sql(
        f"""
        SELECT
            soi.parent,
            soi.item_code,
            SUM(soi.qty - IFNULL(soi.delivered_qty, 0)) AS pending_qty
        FROM `tabSales Order Item` soi
        WHERE soi.parent IN ({name_ph})
          AND soi.qty > IFNULL(soi.delivered_qty, 0)
        GROUP BY soi.parent, soi.item_code
        """,
        order_names,
        as_dict=1,
    )

    unique_items = list({i.item_code for i in items})
    stock_map = {}
    if unique_items:
        item_ph = ", ".join(["%s"] * len(unique_items))
        stock_rows = frappe.db.sql(
            f"""
            SELECT item_code, IFNULL(SUM(actual_qty), 0) AS available_qty
            FROM `tabBin`
            WHERE item_code IN ({item_ph})
            GROUP BY item_code
            """,
            unique_items,
            as_dict=1,
        )
        stock_map = {s.item_code: float(s.available_qty) for s in stock_rows}

    order_items_map = defaultdict(list)
    for item in items:
        order_items_map[item.parent].append(item)

    for o in orders:
        o_items = order_items_map.get(o.name, [])
        if not o_items:
            o["stock_status"] = "ok"
            continue
        ok_count = sum(
            1 for i in o_items
            if stock_map.get(i.item_code, 0) >= float(i.pending_qty)
        )
        if ok_count == len(o_items):
            o["stock_status"] = "ok"
        elif ok_count > 0:
            o["stock_status"] = "partial"
        else:
            o["stock_status"] = "none"

    return orders


@frappe.whitelist()
def get_order_items_with_stock(order_name):
    """Per-order item breakdown with current stock levels."""
    so = frappe.get_doc("Sales Order", order_name)
    result = []
    for item in so.items:
        pending = item.qty - (item.delivered_qty or 0)
        if pending <= 0:
            continue
        available = frappe.db.sql(
            "SELECT IFNULL(SUM(actual_qty), 0) AS qty FROM `tabBin` WHERE item_code = %s",
            (item.item_code,),
            as_dict=1,
        )[0].qty or 0
        result.append(
            {
                "item_code": item.item_code,
                "item_name": item.item_name,
                "required_qty": float(pending),
                "uom": item.uom,
                "available_qty": float(available),
                "shortage": max(float(pending) - float(available), 0),
                "rate": float(item.rate),
                "amount": float(item.amount),
            }
        )
    return result


@frappe.whitelist()
def set_truck_number(order_name, truck_number):
    frappe.db.set_value("Sales Order", order_name, "custom_truck_number", truck_number or "")
    return True


@frappe.whitelist()
def create_material_request_for_orders(order_names):
    """
    Create a draft Manufacture Material Request for all items with shortages
    across the given orders. Returns the MR name.
    """
    import json

    if isinstance(order_names, str):
        order_names = json.loads(order_names)

    item_shortages = {}
    for order_name in order_names:
        for item in get_order_items_with_stock(order_name):
            if item["shortage"] > 0:
                code = item["item_code"]
                if code not in item_shortages:
                    item_shortages[code] = {
                        "item_code": code,
                        "item_name": item["item_name"],
                        "shortage": 0,
                        "uom": item["uom"],
                    }
                item_shortages[code]["shortage"] += item["shortage"]

    if not item_shortages:
        frappe.throw(_("No shortages found for the selected orders"))

    mr = frappe.new_doc("Material Request")
    mr.material_request_type = "Manufacture"
    mr.transaction_date = frappe.utils.today()
    mr.schedule_date = frappe.utils.add_days(frappe.utils.today(), 7)

    for code, data in item_shortages.items():
        warehouse = frappe.db.get_value(
            "Item Default", {"parent": code}, "default_warehouse"
        ) or frappe.db.get_value("Warehouse", {"is_group": 0, "disabled": 0}, "name")
        mr.append(
            "items",
            {
                "item_code": code,
                "item_name": data["item_name"],
                "qty": data["shortage"],
                "uom": data["uom"],
                "schedule_date": mr.schedule_date,
                "warehouse": warehouse,
            },
        )

    mr.insert(ignore_permissions=False)
    return mr.name
