import frappe

@frappe.whitelist()
def set_truck_number(order_name, truck_number):
    frappe.db.set_value('Sales Order', order_name, 'custom_truck_number', truck_number or '')
    return True

@frappe.whitelist()
def set_truck_closed(order_name, value=1):
    frappe.db.set_value('Sales Order', order_name, 'custom_truck_closed', int(value))
    return True
