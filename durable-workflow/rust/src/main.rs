use durable_workflow::{
    Definition, Engine, Result,
    activity::{CATALOG, Onboarding, onboarding},
    now, worker,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

const USAGE: &str = "durable-workflow DATA_DIR COMMAND
  init
  draft NAME AUTHOR [DEFINITION.json]
  edit DRAFT AUTHOR DEFINITION.json | submit DRAFT AUTHOR
  approve DRAFT REVIEWER | reject DRAFT REVIEWER
  simulate DEFINITION.json [CHOICES_JSON]
  start NAME ENTITY_KIND ENTITY_ID [INPUT_JSON] [--request-key KEY]
  worker CONCURRENCY [STAGE ...]
  status INSTANCE | audit INSTANCE | retry INSTANCE OPERATOR | coverage | metrics";

fn definition(file: &str) -> Result<Definition> {
    Ok(serde_json::from_slice(&fs::read(file)?)?)
}
fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let Some((root, args)) = args.split_first() else {
        return Err(USAGE.into());
    };
    let dir = Path::new(root);
    let database = dir.join("workflow.db");
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    if args == ["init"] {
        fs::create_dir_all(dir)?;
        Engine::init(&database)?;
        Onboarding::init(&dir.join("activity.db"))?;
        return Ok(());
    }
    if let ["simulate", file, rest @ ..] = args.as_slice() {
        let flow = definition(file)?;
        flow.validate(CATALOG)?;
        let choices = match rest {
            [] => BTreeMap::new(),
            [json] => serde_json::from_str(json)?,
            _ => return Err(USAGE.into()),
        };
        println!("{}", serde_json::to_string(&flow.simulate(&choices)?)?);
        return Ok(());
    }
    let mut engine = Engine::open(&database)?;
    let result = match args.as_slice() {
        ["draft", name, author] => json!(engine.draft(name, &onboarding(), author)?),
        ["draft", name, author, file] => json!(engine.draft(name, &definition(file)?, author)?),
        ["edit", id, author, file] => {
            engine.edit(id.parse()?, author, &definition(file)?)?;
            Value::Null
        }
        ["submit", id, author] => {
            engine.submit(id.parse()?, author)?;
            Value::Null
        }
        ["approve", id, reviewer] => {
            let version = engine.approve(id.parse()?, reviewer, CATALOG)?;
            json!({"version":version,"unhostedStages":engine.coverage()?})
        }
        ["reject", id, reviewer] => {
            engine.reject(id.parse()?, reviewer)?;
            Value::Null
        }
        ["start", name, kind, entity, rest @ ..] => {
            let (input_args, request_key) = match rest {
                [input @ .., "--request-key", key] => (input, Some(*key)),
                _ => (rest, None),
            };
            let input = match input_args {
                [] => Value::Null,
                [json] => serde_json::from_str(json)?,
                _ => return Err(USAGE.into()),
            };
            json!(engine.start_with_request_key(name, kind, entity, &input, now(), request_key)?)
        }
        ["worker", limit, filter @ ..] => {
            engine.validate_installed(CATALOG)?;
            let stages = worker::hosted(
                CATALOG,
                &filter.iter().map(|k| k.to_string()).collect::<Vec<_>>(),
            )?;
            let stop = Arc::new(AtomicBool::new(false));
            for signal in [signal_hook::consts::SIGINT, signal_hook::consts::SIGTERM] {
                signal_hook::flag::register(signal, Arc::clone(&stop))?;
            }
            let activity = Onboarding::open(&dir.join("activity.db"))?;
            worker::run(
                database,
                stages,
                limit.parse()?,
                Arc::new(activity),
                stop,
                now,
            )?;
            Value::Null
        }
        ["retry", id, operator] => {
            engine.retry(id.parse()?, operator, now())?;
            Value::Null
        }
        ["status", id] => engine.status(id.parse()?)?,
        ["audit", id] => json!(engine.audit(id.parse()?)?),
        ["coverage"] => json!(engine.coverage()?),
        ["metrics"] => engine.metrics(now())?,
        _ => return Err(USAGE.into()),
    };
    if !result.is_null() {
        println!("{}", serde_json::to_string(&result)?);
    }
    Ok(())
}
