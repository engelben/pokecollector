import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getBudgetCart, postBudgetCartItem, putBudgetCartItem, removeBudgetCartItem } from '../api/client'

export function useBudgetCart(enabled = true) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['budget-cart', null], queryFn: () => getBudgetCart(), enabled })
  const refresh = () => client.invalidateQueries({ queryKey: ['budget-cart'] })
  const add = useMutation({ mutationFn: card_id => postBudgetCartItem({ card_id, quantity: 1 }), onSuccess: refresh })
  const setQuantity = useMutation({ mutationFn: ({ card_id, quantity }) => putBudgetCartItem({ card_id, quantity }), onSuccess: refresh })
  const remove = useMutation({ mutationFn: card_id => removeBudgetCartItem(card_id), onSuccess: refresh })
  const cartItemByCardId = useMemo(() => new Map((query.data?.items || []).map(item => [item.card_id, item])), [query.data])
  return { cart: query.data, cartItemByCardId, add, setQuantity, remove, isMutating: add.isPending || setQuantity.isPending || remove.isPending }
}
