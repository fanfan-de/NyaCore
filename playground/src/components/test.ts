import { Context } from '@nya/core'
import type { Component } from '@nya/core'

const app = new Context()


//定义一个组件
const componentA: Component = {
  name: 'component-a',
  apply(ctx) {
    ctx.effect(()=>{
      //effect
      return ()=>{}
    }
    )
    return ()=>{
    }
  }
}


//安装这个组件
const fiber= app.installComponent(componentA)
