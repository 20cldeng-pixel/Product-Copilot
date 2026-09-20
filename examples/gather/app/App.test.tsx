import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createInitialState, type AppState } from './domain';
import type { StateRepository } from './repository';

function createRepository(state: AppState = createInitialState()) {
  return {
    load: vi.fn(() => state),
    save: vi.fn(),
  } satisfies StateRepository;
}

function createPersistentRepository(state: AppState) {
  let storedState = state;
  return {
    load: vi.fn(() => storedState),
    save: vi.fn((candidate: AppState) => { storedState = candidate; }),
  } satisfies StateRepository;
}

function eventCard(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const card = heading.closest('article');
  if (!card) throw new Error(`未找到活动卡片：${name}`);
  return card;
}

async function switchToMember(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '成员报名' }));
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('管理员关键交互', () => {
  it('创建活动成功后持久化并显示新活动', async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    render(<App repository={repository} />);

    await user.type(screen.getByLabelText('活动名称'), '读书会');
    await user.type(screen.getByLabelText('容量'), '4');
    await user.click(screen.getByRole('button', { name: '创建活动' }));

    expect(repository.save).toHaveBeenCalledOnce();
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      eventOrder: ['A1', 'A2', 'A3', 'A4'],
      eventsById: expect.objectContaining({
        A4: { id: 'A4', name: 'A4 · 读书会', capacity: 4, open: true },
      }),
    }));
    expect(screen.getByRole('heading', { name: 'A4 · 读书会' })).toBeInTheDocument();
    expect(screen.getByText('活动已创建')).toBeInTheDocument();
  });

  it('创建活动后重新挂载仍恢复名称、容量和关闭状态', async () => {
    const user = userEvent.setup();
    const repository = createPersistentRepository(createInitialState());
    const first = render(<App repository={repository} />);

    await user.type(screen.getByLabelText('活动名称'), '复盘会');
    await user.type(screen.getByLabelText('容量'), '3');
    await user.click(screen.getByRole('radio', { name: '暂不开放' }));
    await user.click(screen.getByRole('button', { name: '创建活动' }));
    first.unmount();
    render(<App repository={repository} />);

    const card = eventCard('A4 · 复盘会');
    expect(card).toHaveTextContent('0 / 3 人');
    expect(card).toHaveTextContent('已关闭');
  });

  it('创建表单逐项拒绝空名称、空容量、零、负数和非整数且不写入', async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    render(<App repository={repository} />);

    await user.click(screen.getByRole('button', { name: '创建活动' }));
    expect(screen.getByText('请填写活动名称。')).toBeInTheDocument();

    await user.type(screen.getByLabelText('活动名称'), '无效活动');
    const capacity = screen.getByLabelText('容量');
    for (const invalid of ['', '0', '-1', '1.5']) {
      await user.clear(capacity);
      if (invalid) await user.type(capacity, invalid);
      await user.click(screen.getByRole('button', { name: '创建活动' }));
      expect(capacity).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getAllByText('容量必须是大于 0 的整数。').length).toBeGreaterThanOrEqual(2);
    }
    expect(repository.save).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: /无效活动/ })).not.toBeInTheDocument();
  });

  it('切换活动开放状态后持久化并更新操作', async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    render(<App repository={repository} />);

    const card = eventCard('A1 · 社群早餐会');
    await user.click(within(card).getByRole('button', { name: '关闭报名' }));

    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      eventsById: expect.objectContaining({ A1: expect.objectContaining({ open: false }) }),
    }));
    expect(within(card).getByRole('button', { name: '开放报名' })).toBeInTheDocument();
    expect(screen.getByText('报名已关闭')).toBeInTheDocument();
  });

  it('名单弹窗分别呈现空名单与非空名单', async () => {
    const user = userEvent.setup();
    render(<App repository={createRepository()} />);

    await user.click(within(eventCard('A1 · 社群早餐会')).getByRole('button', { name: '查看名单' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('暂时还没有成员报名。');
    await user.click(screen.getByRole('button', { name: '关闭名单' }));

    await user.click(within(eventCard('A2 · 产品交流夜')).getByRole('button', { name: '查看名单' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByText('U2')).toHaveLength(2);
    expect(within(dialog).getAllByText('U3')).toHaveLength(2);
  });
});

describe('成员关键交互', () => {
  it('未选择身份时显示提示并拒绝提交', async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    render(<App repository={repository} />);
    await switchToMember(user);

    expect(screen.getByText('尚未选择身份')).toBeInTheDocument();
    await user.click(within(eventCard('社群早餐会')).getByRole('button', { name: '选择身份' }));

    expect(screen.getByText('请先选择身份')).toBeInTheDocument();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('大容量活动保留准确人数且不会按容量展开大量装饰节点', async () => {
    const user = userEvent.setup();
    const state = createInitialState();
    state.eventsById.A1.capacity = 1000000;
    render(<App repository={createRepository(state)} />);
    await switchToMember(user);
    const card = eventCard('社群早餐会');
    expect(within(card).getByText('0 / 1000000 人已报名')).toBeInTheDocument();
    expect(card.querySelectorAll('.seat').length).toBeLessThanOrEqual(20);
  });

  it('已有报名身份仍可报名其他活动，同一活动重复提交被拒绝', async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    render(<App repository={repository} />);
    await switchToMember(user);

    await user.click(screen.getByRole('button', { name: 'U2' }));

    expect(screen.getByText('U2 已报名 1 场')).toBeInTheDocument();
    expect(screen.getByText(/仍可报名其他符合条件的活动/)).toBeInTheDocument();
    const card = eventCard('社群早餐会');
    await user.click(within(card).getByRole('button', { name: '立即报名' }));

    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      registrationsByUserId: { U2: ['A2', 'A1'], U3: ['A2'] },
    }));
    expect(within(card).getByRole('button', { name: '已报名' })).toBeInTheDocument();

    repository.save.mockClear();
    await user.click(within(card).getByRole('button', { name: '已报名' }));
    expect(repository.save).not.toHaveBeenCalled();
    expect(screen.getByText('不能重复报名')).toBeInTheDocument();
  });

  it('可用身份成功报名并立即更新资格与人数', async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    render(<App repository={repository} />);
    await switchToMember(user);

    await user.click(screen.getByRole('button', { name: 'U1' }));
    const card = eventCard('社群早餐会');
    await user.click(within(card).getByRole('button', { name: '立即报名' }));

    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      registrationsByUserId: { U1: ['A1'], U2: ['A2'], U3: ['A2'] },
    }));
    expect(screen.getByText('报名成功')).toBeInTheDocument();
    expect(screen.getByText('U1 已报名 1 场')).toBeInTheDocument();
    expect(within(card).getByText('1 / 2 人已报名')).toBeInTheDocument();
  });

  it('VC-08 隔离页面序列在刷新后保留逐活动状态、容量和报名关系', async () => {
    const user = userEvent.setup();
    const f0 = createInitialState();
    f0.registrationsByUserId = {};
    const repository = createPersistentRepository(f0);
    const first = render(<App repository={repository} />);

    expect(eventCard('A1 · 社群早餐会')).toHaveTextContent('0 / 2 人');
    expect(eventCard('A2 · 产品交流夜')).toHaveTextContent('0 / 2 人');
    expect(eventCard('A3 · 周末工作坊')).toHaveTextContent('已关闭');

    await switchToMember(user);
    await user.click(screen.getByRole('button', { name: 'U1' }));
    await user.click(within(eventCard('社群早餐会')).getByRole('button', { name: '立即报名' }));
    expect(within(eventCard('产品交流夜')).getByRole('button', { name: '立即报名' })).toBeInTheDocument();
    expect(within(eventCard('社群早餐会')).getByRole('button', { name: '已报名' })).toBeInTheDocument();

    await user.click(within(eventCard('产品交流夜')).getByRole('button', { name: '立即报名' }));
    await user.click(screen.getByRole('button', { name: 'U2' }));
    await user.click(within(eventCard('社群早餐会')).getByRole('button', { name: '立即报名' }));
    await user.click(screen.getByRole('button', { name: 'U3' }));
    expect(within(eventCard('社群早餐会')).getByRole('button', { name: '活动已满员' })).toBeInTheDocument();
    expect(within(eventCard('周末工作坊')).getByRole('button', { name: '报名已关闭' })).toBeInTheDocument();

    first.unmount();
    render(<App repository={repository} />);
    await switchToMember(user);
    await user.click(screen.getByRole('button', { name: 'U1' }));

    expect(screen.getByText('U1 已报名 2 场')).toBeInTheDocument();
    expect(screen.getAllByText(/A1 · 社群早餐会、A2 · 产品交流夜/)).toHaveLength(2);
    expect(within(eventCard('社群早餐会')).getByText('2 / 2 人已报名')).toBeInTheDocument();
    expect(within(eventCard('产品交流夜')).getByText('1 / 2 人已报名')).toBeInTheDocument();
    expect(within(eventCard('社群早餐会')).getByRole('button', { name: '已报名' })).toBeInTheDocument();
    expect(within(eventCard('产品交流夜')).getByRole('button', { name: '已报名' })).toBeInTheDocument();
    expect(within(eventCard('社群早餐会')).getByText(/无需重复提交/)).toBeInTheDocument();
    expect(within(eventCard('周末工作坊')).getByText('管理员尚未开放这场活动。')).toBeInTheDocument();
  });

  it('刷新后已报名当前活动仍被拦截，其他开放活动保持可提交', async () => {
    const user = userEvent.setup();
    const state = createInitialState();
    state.registrationsByUserId = { U1: ['A1'] };
    const repository = createPersistentRepository(state);
    const first = render(<App repository={repository} />);
    first.unmount();
    render(<App repository={repository} />);

    await switchToMember(user);
    await user.click(screen.getByRole('button', { name: 'U1' }));

    expect(within(eventCard('社群早餐会')).getByRole('button', { name: '已报名' })).toBeInTheDocument();
    expect(within(eventCard('产品交流夜')).getByRole('button', { name: '立即报名' })).toBeInTheDocument();
  });
});

describe('Repository 写入失败回滚', () => {
  function failingRepository() {
    const repository = createRepository();
    repository.save.mockImplementation(() => {
      throw new Error('quota');
    });
    return repository;
  }

  it('创建写入失败时不显示新活动或成功反馈', async () => {
    const user = userEvent.setup();
    render(<App repository={failingRepository()} />);

    await user.type(screen.getByLabelText('活动名称'), '不会保存的活动');
    await user.type(screen.getByLabelText('容量'), '2');
    await user.click(screen.getByRole('button', { name: '创建活动' }));

    expect(screen.queryByRole('heading', { name: /不会保存的活动/ })).not.toBeInTheDocument();
    expect(screen.queryByText('活动已创建')).not.toBeInTheDocument();
    expect(screen.getAllByText('更改未保存').length).toBeGreaterThan(0);
  });

  it('状态切换写入失败时仍保持原开放状态', async () => {
    const user = userEvent.setup();
    render(<App repository={failingRepository()} />);

    const card = eventCard('A1 · 社群早餐会');
    await user.click(within(card).getByRole('button', { name: '关闭报名' }));

    expect(within(card).getByRole('button', { name: '关闭报名' })).toBeInTheDocument();
    expect(screen.queryByText('报名已关闭')).not.toBeInTheDocument();
    expect(screen.getAllByText('更改未保存').length).toBeGreaterThan(0);
  });

  it('报名写入失败时人数和身份资格均不产生假成功', async () => {
    const user = userEvent.setup();
    render(<App repository={failingRepository()} />);
    await switchToMember(user);
    await user.click(screen.getByRole('button', { name: 'U1' }));

    const card = eventCard('社群早餐会');
    await user.click(within(card).getByRole('button', { name: '立即报名' }));

    expect(within(card).getByText('0 / 2 人已报名')).toBeInTheDocument();
    expect(screen.getByText('U1 可以报名')).toBeInTheDocument();
    expect(screen.queryByText('报名成功')).not.toBeInTheDocument();
    expect(screen.getAllByText('更改未保存').length).toBeGreaterThan(0);
  });
});

describe('体验事件采集隔离', () => {
  it('事件存储写入失败不改变成功报名，页面提示采集缺口', async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    render(<App repository={repository} />);
    await switchToMember(user);
    await user.click(screen.getByRole('button', { name: 'U1' }));
    await user.click(within(eventCard('社群早餐会')).getByRole('button', { name: '立即报名' }));

    expect(repository.save).toHaveBeenCalledOnce();
    expect(within(eventCard('社群早餐会')).getByText('1 / 2 人已报名')).toBeInTheDocument();
    expect(screen.getByText('报名成功')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('体验事件未完整保存');
  });
});
