import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import type { ContactTask } from '../../types/index.js'
import Button from '../ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card'
import { Trash2, Plus, CheckSquare } from 'lucide-react'

interface TasksSectionProps {
  contactId: string
  clientId: string
}

export default function TasksSection({ contactId, clientId }: TasksSectionProps) {
  const [tasks, setTasks] = useState<ContactTask[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDueDate, setNewDueDate] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchTasks()
  }, [contactId, clientId])

  const fetchTasks = async () => {
    try {
      const { data, error } = await supabase
        .from('contact_tasks')
        .select('*')
        .eq('contact_id', contactId)
        .eq('client_id', clientId)
        .order('is_completed', { ascending: true })
        .order('due_date', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false })

      if (error) throw error
      setTasks(data || [])
    } catch (err) {
      console.error('Error fetching tasks:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleAddTask = async () => {
    if (!newTitle.trim()) return
    setSubmitting(true)

    try {
      const { error } = await supabase.from('contact_tasks').insert({
        contact_id: contactId,
        client_id: clientId,
        title: newTitle.trim(),
        due_date: newDueDate || null,
        is_completed: false,
        created_by: 'web',
      })

      if (error) throw error
      setNewTitle('')
      setNewDueDate('')
      setShowAddForm(false)
      fetchTasks()
    } catch (err) {
      console.error('Error adding task:', err)
    } finally {
      setSubmitting(false)
    }
  }

  const toggleComplete = async (task: ContactTask) => {
    const nowCompleted = !task.is_completed
    try {
      const { error } = await supabase
        .from('contact_tasks')
        .update({
          is_completed: nowCompleted,
          completed_at: nowCompleted ? new Date().toISOString() : null,
        })
        .eq('id', task.id)

      if (error) throw error
      fetchTasks()
    } catch (err) {
      console.error('Error toggling task:', err)
    }
  }

  const deleteTask = async (taskId: string) => {
    try {
      const { error } = await supabase
        .from('contact_tasks')
        .delete()
        .eq('id', taskId)

      if (error) throw error
      setTasks((prev) => prev.filter((t) => t.id !== taskId))
    } catch (err) {
      console.error('Error deleting task:', err)
    }
  }

  const isOverdue = (dueDate: string | undefined): boolean => {
    if (!dueDate) return false
    return new Date(dueDate) < new Date(new Date().toDateString())
  }

  const incompleteTasks = tasks.filter((t) => !t.is_completed)
  const completedTasks = tasks.filter((t) => t.is_completed)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <CheckSquare className="h-4 w-4" />
            Tasks
          </CardTitle>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
            aria-label="Add task"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        {showAddForm && (
          <div className="mb-3 p-3 bg-gray-50 rounded-lg border border-gray-200 space-y-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Task title..."
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleAddTask()
                }
              }}
            />
            <input
              type="date"
              value={newDueDate}
              onChange={(e) => setNewDueDate(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowAddForm(false)
                  setNewTitle('')
                  setNewDueDate('')
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleAddTask} disabled={!newTitle.trim() || submitting}>
                {submitting ? 'Adding...' : 'Add'}
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-6">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600" />
          </div>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">No tasks yet.</p>
        ) : (
          <div className="space-y-1">
            {incompleteTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                isOverdue={isOverdue(task.due_date)}
                onToggle={() => toggleComplete(task)}
                onDelete={() => deleteTask(task.id)}
              />
            ))}

            {completedTasks.length > 0 && incompleteTasks.length > 0 && (
              <div className="border-t border-gray-100 my-2" />
            )}

            {completedTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                isOverdue={false}
                onToggle={() => toggleComplete(task)}
                onDelete={() => deleteTask(task.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function TaskRow({
  task,
  isOverdue,
  onToggle,
  onDelete,
}: {
  task: ContactTask
  isOverdue: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    <div className="group flex items-center gap-2 py-1.5 px-1 rounded hover:bg-gray-50">
      <input
        type="checkbox"
        checked={task.is_completed}
        onChange={onToggle}
        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0"
      />
      <div className="flex-1 min-w-0">
        <span className={`text-sm ${task.is_completed ? 'line-through text-gray-400' : 'text-gray-900'}`}>
          {task.title}
        </span>
        {task.due_date && (
          <span className={`ml-2 text-xs ${
            task.is_completed ? 'text-gray-400' : isOverdue ? 'text-red-600 font-medium' : 'text-gray-500'
          }`}>
            {new Date(task.due_date + 'T00:00:00').toLocaleDateString()}
          </span>
        )}
      </div>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-all"
        aria-label="Delete task"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
