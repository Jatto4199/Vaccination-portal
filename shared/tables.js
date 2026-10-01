// Records synchronized between clinic nodes and the central server
// (thesis section 3.13).
//
// Every synced row also carries the synchronization metadata of section 3.13:
//   id                 unique record identifier (UUID created on the node)
//   version            version number, incremented by the server on each accepted change
//   server_seq         global order assigned by the server (used for pulling)
//   updated_at         last modified timestamp (server time)
//   updated_by_node    node identifier of the last accepted change
// The change type and synchronization status of each change are kept in the
// Synchronization Record table.
//
//   fields       data columns a node may send
//   critical     fields never overwritten automatically on conflict; they go to
//                an administrator for review instead (section 3.14)
//   appendOnly   records are never edited after creation, except `mutable` fields
//   pushOnly     sent to the server but never pulled back to nodes

export const SYNC_TABLES = {
  guardians: {
    fields: ['full_name', 'relationship', 'phone', 'address', 'id_number', 'preferred_notification', 'sms_consent',
      'patient_id', 'clinic_id'],
    critical: [],
    clinicField: 'clinic_id',
  },
  patients: {
    fields: ['patient_number', 'type', 'full_name', 'dob', 'sex', 'address', 'guardian_id',
      'clinic_id', 'registration_date', 'registered_by', 'merged_into_id'],
    critical: ['type', 'dob', 'sex'],
    clinicField: 'clinic_id',
  },
  vaccination_records: {
    fields: ['patient_id', 'vaccine_id', 'dose_number', 'date_administered', 'administered_by', 'administered_by_name',
      'clinic_id', 'batch_number', 'record_status', 'void_reason', 'voided_by', 'voided_at'],
    critical: [],
    appendOnly: true,
    mutable: ['record_status', 'void_reason', 'voided_by', 'voided_at'],
    clinicField: 'clinic_id',
  },
  audit_log: {
    fields: ['user_id', 'username', 'action', 'entity', 'entity_id', 'detail', 'at', 'clinic_id', 'node_id'],
    critical: [],
    appendOnly: true,
    mutable: [],
    pushOnly: true,
    clinicField: 'clinic_id',
  },
};

export const SYNC_TABLE_NAMES = Object.keys(SYNC_TABLES);
export const PULL_TABLE_NAMES = SYNC_TABLE_NAMES.filter((t) => !SYNC_TABLES[t].pushOnly);

// Normalizes a name for duplicate detection: case, punctuation and word order
// are ignored, so "Amina Bello" matches "BELLO, Amina".
export function normalizeName(name) {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}
