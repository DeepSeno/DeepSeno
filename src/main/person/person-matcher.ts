import type { VoiceBrainDB } from '../db/database';

export interface MatchOrCreateResult {
  personId: number;
  isNew: boolean;
  confidence: number;
  matchedExisting?: { id: number; name: string | null; similarity: number };
}

export interface IdentifierMatch {
  personId: number;
  personName: string | null;
  matchType: string;
  similarity: number;
}

export class PersonMatcher {
  constructor(private db: VoiceBrainDB) {}

  matchByIdentifier(
    type: 'phone' | 'wechat' | 'email',
    value: string,
  ): IdentifierMatch | null {
    const person = this.db.findPersonByIdentifier(type, value);
    if (!person) return null;
    return { personId: person.id, personName: person.name, matchType: type, similarity: 1.0 };
  }

  matchByName(name: string): IdentifierMatch | null {
    const person = this.db.getPersonByName(name);
    if (person) {
      return { personId: person.id, personName: person.name, matchType: 'name', similarity: 1.0 };
    }
    const aliasPerson = this.db.findPersonByIdentifier('name_alias', name);
    if (aliasPerson) {
      return { personId: aliasPerson.id, personName: aliasPerson.name, matchType: 'name_alias', similarity: 1.0 };
    }
    return null;
  }

  /**
   * Match by identifier only — no auto-creation of persons.
   * Returns null if no matching person is found.
   */
  matchFromIdentifier(opts: {
    type: 'phone' | 'wechat' | 'email';
    value: string;
  }): MatchOrCreateResult | null {
    const { type, value } = opts;
    const match = this.matchByIdentifier(type, value);
    if (match) {
      return {
        personId: match.personId, isNew: false, confidence: 1.0,
        matchedExisting: { id: match.personId, name: match.personName, similarity: 1.0 },
      };
    }
    return null;
  }

  linkContentToPerson(segmentId: number, personId: number, role: string, confidence?: number): void {
    this.db.insertContentPersonLink({ segment_id: segmentId, person_id: personId, role, confidence, source: 'auto' });
  }

  merge(fromId: number, toId: number): void {
    this.db.mergePersons(fromId, toId);
  }
}
