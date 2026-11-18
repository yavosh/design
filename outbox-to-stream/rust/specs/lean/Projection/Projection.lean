structure State where
  rev : Nat
  seen : List Nat
  deriving BEq, DecidableEq, Repr

inductive Event where
  | apply (r : Nat)     -- src/consumer.rs:49-76, event transaction
  | snapshot (r : Nat)  -- src/consumer.rs:103-118, snapshot transaction
  deriving Repr

def init : State := ⟨0, []⟩

def merge (guarded : Bool) (old incoming : Nat) : Nat :=
  if guarded then max old incoming else incoming

def step (guarded : Bool) (s : State) : Event → State
  | .apply r => if r ∈ s.seen then s else ⟨merge guarded s.rev r, r :: s.seen⟩
  | .snapshot r => { s with rev := merge guarded s.rev r }

def CoversSeen (s : State) := ∀ r ∈ s.seen, r ≤ s.rev

theorem inv_init : CoversSeen init := by simp [CoversSeen, init]

theorem monotone (s : State) (e : Event) : s.rev ≤ (step true s e).rev := by
  cases e with
  | apply r => by_cases h : r ∈ s.seen <;> simp [step, h, merge, Nat.le_max_left]
  | snapshot r => simp [step, merge, Nat.le_max_left]

theorem inv_step {s : State} (hs : CoversSeen s) (e : Event) : CoversSeen (step true s e) := by
  cases e with
  | snapshot r =>
    intro k hk
    exact Nat.le_trans (hs k hk) (Nat.le_max_left _ _)
  | apply r =>
    by_cases h : r ∈ s.seen
    · simpa [step, h] using hs
    · intro k hk
      simp [step,h] at hk
      simp [step,h,merge]
      rcases hk with hkr | hks
      · subst k; exact Nat.le_max_right _ _
      · exact Nat.le_trans (hs k hks) (Nat.le_max_left _ _)

theorem histories (events : List Event) (s : State) (hs : CoversSeen s) :
    CoversSeen (events.foldl (step true) s) := by
  induction events generalizing s with
  | nil => exact hs
  | cons e es ih => exact ih _ (inv_step hs e)

theorem duplicate (s : State) (r : Nat) :
    step true (step true s (.apply r)) (.apply r) = step true s (.apply r) := by
  by_cases h : r ∈ s.seen <;> simp [step,h]

theorem agreement (s : State) (e : Event)
    (h : s.rev ≤ (step false s e).rev) : step true s e = step false s e := by
  cases e with
  | snapshot r => simp [step,merge] at h ⊢; exact Nat.max_eq_right h
  | apply r =>
    by_cases seen : r ∈ s.seen
    · simp [step,seen]
    · simp [step,seen,merge] at h ⊢; exact Nat.max_eq_right h

def replay (s : State) : List (Event × State) → Bool
  | [] => true
  | (e, observed) :: rest => step true s e == observed && replay observed rest

theorem unguarded_regresses :
    (step false (step false init (.apply 2)) (.apply 1)).rev = 1 := by decide

theorem observed : replay init [
    (.apply 2, ⟨2,[2]⟩), (.apply 1, ⟨2,[1,2]⟩), (.apply 2, ⟨2,[1,2]⟩),
    (.snapshot 3, ⟨3,[1,2]⟩), (.apply 3, ⟨3,[3,1,2]⟩)] = true := by decide

-- The producer encodes a unique revision in the canonical key for this record.
-- A mismatched identity fails validation before the SQLite transaction starts.
def deliver (validate : Bool) (s : State) (revision key : Nat) : Option State :=
  if validate && key != revision then none
  else if key ∈ s.seen then some s
  else some ⟨max s.rev revision, key :: s.seen⟩

theorem canonical_agreement (s : State) (r : Nat) :
    deliver true s r r = some (step true s (.apply r)) := by
  by_cases h : r ∈ s.seen <;> simp [deliver,step,merge,h]

theorem accepted_covers {s t : State} {r k : Nat} (hs : CoversSeen s)
    (h : deliver true s r k = some t) : r ≤ t.rev := by
  by_cases hk : k = r
  · subst k
    by_cases member : r ∈ s.seen
    · simp [deliver,member] at h; subst t; exact hs r member
    · simp [deliver,member] at h; subst t; exact Nat.le_max_right _ _
  · simp [deliver,hk] at h

theorem before_silently_drops :
    (deliver false init 1 1 >>= fun s => deliver false s 2 1) = some ⟨1,[1]⟩ := by decide

def Event.revision : Event → Nat
  | .apply r | .snapshot r => r

theorem exact_revision (s : State) (hs : CoversSeen s) (e : Event) :
    (step true s e).rev = max s.rev e.revision := by
  cases e with
  | snapshot r => rfl
  | apply r =>
    by_cases member : r ∈ s.seen
    · simpa [step,member,Event.revision] using (Nat.max_eq_left (hs r member)).symm
    · simp [step,member,merge,Event.revision]

theorem exact_history (events : List Event) (s : State) (hs : CoversSeen s) :
    (events.foldl (step true) s).rev = events.foldl (fun n e => max n e.revision) s.rev := by
  induction events generalizing s with
  | nil => rfl
  | cons e es ih =>
    simp only [List.foldl_cons]
    rw [ih _ (inv_step hs e), exact_revision s hs e]
