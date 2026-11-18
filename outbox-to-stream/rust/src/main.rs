use outbox_stream::{Consumer, Group, Producer, Result, Stream, clock, init};
use std::{path::Path, thread::sleep, time::Duration};

const USAGE: &str = "usage: outbox-stream DIR init | update ID STATUS REQUEST | relay | consume projection|jobs INSTANCE | worker URL | bootstrap | replay EVENT | redrive GROUP ENTRY | resume-reconciled GROUP TRIMMED_THROUGH | maintain | status";

fn group(name: &str) -> Result<Group> {
    Group::ALL
        .into_iter()
        .find(|g| g.name() == name)
        .ok_or_else(|| "unknown group".into())
}

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let Some((dir, cmd)) = args.split_first() else {
        return Err(USAGE.into());
    };
    let dir = Path::new(dir);
    let args: Vec<_> = cmd.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["init"] => init(dir)?,
        ["update", id, status, request] => println!(
            "{}",
            Producer::open(dir)?.update(id, status, request, None)?
        ),
        ["relay"] => {
            let mut producer = Producer::open(dir)?;
            let stream = Stream::open(dir)?;
            loop {
                if producer.drain(&stream)? == 0 {
                    sleep(Duration::from_secs(2))
                } else {
                    std::thread::yield_now()
                }
            }
        }
        ["consume", name, instance] => {
            let g = group(name)?;
            let mut consumer = Consumer::open(dir, g)?;
            let mut stream = Stream::open(dir)?;
            if g == Group::Projection && !stream.enrolled(g)? {
                consumer.bootstrap(&mut Producer::open(dir)?, &mut stream)?;
            } else {
                stream.enroll(g)?;
            }
            loop {
                if consumer.tick(&mut stream, instance, clock())? == 0 {
                    sleep(Duration::from_millis(200))
                }
            }
        }
        ["worker", url] => {
            let worker = outbox_stream::Worker::open(dir, url)?;
            loop {
                if !worker.tick(clock())? {
                    sleep(Duration::from_secs(1));
                }
            }
        }
        ["bootstrap"] => Consumer::open(dir, Group::Projection)?
            .bootstrap(&mut Producer::open(dir)?, &mut Stream::open(dir)?)?,
        ["replay", id] => {
            if !Producer::open(dir)?.replay(id, clock())? {
                return Err("no retained eligible event".into());
            }
        }
        ["redrive", name, id] => {
            if !Stream::open(dir)?.redrive(group(name)?, id.parse()?, clock())? {
                return Err("no retained dead letter".into());
            }
        }
        ["resume-reconciled", name, floor] => {
            if !Stream::open(dir)?.resume_reconciled(group(name)?, floor.parse()?)? {
                return Err("group has no gap at the supplied retention boundary".into());
            }
        }
        ["maintain"] => {
            let now = clock();
            println!(
                "sent_rows_removed={} stream_entries_removed={}",
                Producer::open(dir)?.clean(now)?,
                Stream::open(dir)?.trim(now)?
            );
        }
        ["status"] => println!("{}", outbox_stream::status(dir)?),
        _ => return Err(USAGE.into()),
    }
    Ok(())
}
