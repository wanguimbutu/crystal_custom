# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class CrystalTruck(Document):
	def validate(self):
		if self.truck_number:
			self.truck_number = self.truck_number.strip().upper()
		if self.status == "Dismantled" and not self.dismantled_on:
			self.dismantled_on = frappe.utils.now_datetime()
		if self.status == "Active":
			self.dismantled_on = None
