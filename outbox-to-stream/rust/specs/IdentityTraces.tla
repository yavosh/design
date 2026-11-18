---- MODULE IdentityTraces ----
EXTENDS Identity, Sequences
VARIABLE i
Trace == <<[r |-> 0, k |-> 0, rev |-> 0, ids |-> {}, done |-> {}],
           [r |-> 1, k |-> 1, rev |-> 1, ids |-> {1}, done |-> {1}],
           [r |-> 2, k |-> 1, rev |-> 1, ids |-> {1}, done |-> {1}],
           [r |-> 2, k |-> 2, rev |-> 2, ids |-> {1,2}, done |-> {1,2}]>>
TraceInit == i = 1 /\ Init /\ revision = Trace[1].rev /\ seen = Trace[1].ids /\ handled = Trace[1].done
TraceNext == \/ /\ i < Len(Trace)
                /\ LET t == Trace[i+1] IN
                   /\ Deliver(t.r,t.k)
                   /\ revision' = t.rev /\ seen' = t.ids /\ handled' = t.done
                /\ i' = i+1
             \/ /\ i = Len(Trace) /\ UNCHANGED <<vars,i>>
====
