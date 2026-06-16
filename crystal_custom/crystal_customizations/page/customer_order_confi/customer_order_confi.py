import frappe
from frappe.utils import flt


@frappe.whitelist()
def get_item_details(item_code):
    """Return item name, UOM, rate and weight for the add-item dialog."""
    item = frappe.db.get_value(
        'Item', item_code,
        ['item_name', 'sales_uom', 'stock_uom', 'weight_per_unit'],
        as_dict=True,
    )
    if not item:
        frappe.throw(f'Item {item_code} not found')

    # Try to get standard selling price
    price = frappe.db.get_value(
        'Item Price',
        {'item_code': item_code, 'selling': 1},
        'price_list_rate',
    ) or 0

    return {
        'item_name':      item.item_name,
        'uom':            item.sales_uom or item.stock_uom or 'Nos',
        'rate':           flt(price),
        'weight_per_unit': flt(item.weight_per_unit),
    }


@frappe.whitelist()
def save_order_changes(order_name, items_json):
    """
    Persist item-level edits (qty changes, removals, additions) to a draft
    Sales Order during customer reconfirmation. Recalculates SO totals.
    Returns the updated grand_total and total_net_weight so the caller
    can refresh the order row without a full page reload.
    """
    import json

    items = json.loads(items_json) if isinstance(items_json, str) else items_json

    so = frappe.get_doc('Sales Order', order_name)
    if so.docstatus != 0:
        frappe.throw('Only draft orders can be modified here.')

    existing_by_name = {i.name: i for i in so.items}
    kept_names       = {d['name'] for d in items if d.get('name')}

    # ── Remove items the customer dropped ──────────────────────────────────
    so.items = [i for i in so.items if i.name in kept_names]

    # ── Update quantities on kept items ────────────────────────────────────
    item_map = {i.name: i for i in so.items}
    for d in items:
        if d.get('name') and d['name'] in item_map:
            row = item_map[d['name']]
            row.qty    = flt(d.get('qty', row.qty))
            row.amount = row.qty * flt(row.rate)

    # ── Append new items ───────────────────────────────────────────────────
    for d in items:
        if not d.get('name'):
            ic   = d['item_code']
            item = frappe.get_doc('Item', ic)
            wh   = (
                frappe.db.get_value(
                    'Item Default',
                    {'parent': ic, 'company': frappe.defaults.get_user_default('Company')},
                    'default_warehouse',
                )
                or frappe.db.get_value('Warehouse', {'is_group': 0, 'disabled': 0}, 'name')
                or ''
            )
            so.append('items', {
                'item_code':       ic,
                'item_name':       item.item_name,
                'qty':             flt(d.get('qty', 1)),
                'rate':            flt(d.get('rate', 0)),
                'amount':          flt(d.get('qty', 1)) * flt(d.get('rate', 0)),
                'uom':             d.get('uom') or item.sales_uom or item.stock_uom or 'Nos',
                'weight_per_unit': flt(item.weight_per_unit),
                'delivery_date':   so.delivery_date,
                'warehouse':       wh,
            })

    so.save(ignore_permissions=True)

    return {
        'status':            'ok',
        'grand_total':       flt(so.grand_total),
        'total_net_weight':  flt(so.total_net_weight),
        'items': [
            {
                'name':            i.name,
                'item_code':       i.item_code,
                'item_name':       i.item_name or '',
                'qty':             flt(i.qty),
                'delivered_qty':   flt(i.delivered_qty),
                'rate':            flt(i.rate),
                'amount':          flt(i.amount),
                'uom':             i.uom or '',
                'weight_per_unit': flt(i.weight_per_unit),
            }
            for i in so.items
        ],
    }


@frappe.whitelist()
def cancel_order(order_name):
    """Cancel a Sales Order during reconfirmation (draft → delete, submitted → cancel)."""
    so = frappe.get_doc('Sales Order', order_name)
    if so.docstatus == 0:
        frappe.delete_doc('Sales Order', order_name, ignore_permissions=True)
    elif so.docstatus == 1:
        so.cancel()
    else:
        frappe.throw('Order is already cancelled.')
    return {'status': 'cancelled'}
