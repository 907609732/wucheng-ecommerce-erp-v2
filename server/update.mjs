/** The adapters own process/service control. Never restores data on rollback. */
export async function switchRelease({
  current,
  candidate,
  check,
  stop,
  snapshot,
  preflight = async () => {},
  write,
  start,
  health,
}) {
  await check(candidate);
  await stop();
  let backup;
  try {
    backup = await snapshot();
  } catch (e) {
    await start(current);
    throw Error("备份未完成，保留原版本：" + e.message);
  }
  try {
    await preflight(backup);
  } catch (e) {
    await start(current);
    throw Error("候选副本验收失败，保留原版本：" + e.message);
  }
  try {
    await write(candidate);
    await start(candidate);
    await health(candidate);
    return { ok: true };
  } catch (error) {
    try {
      await stop();
      await write(current);
      await start(current);
      await health(current);
    } catch (rollback) {
      throw Error(
        "更新失败且回退未通过，请检查服务；账本未自动恢复：" + rollback.message,
        { cause: error },
      );
    }
    throw Error(
      "候选版本未通过，程序已回退，业务数据未回退：" + error.message,
      { cause: error },
    );
  }
}
