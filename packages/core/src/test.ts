const user = {
  name: '小明',
  age: 18,
}

const proxyUser = new Proxy(user, {
  get(target, property) {
    console.log(`正在读取 ${String(property)}`)
    return Reflect.get(target, property)
  },

  set(target, property, value) {
    console.log(`正在修改 ${String(property)}`)

    if (property === 'age' && value < 0) {
      throw new Error('年龄不能小于 0')
    }

    return Reflect.set(target, property, value)
  },
})